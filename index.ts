import { MiniClawServer } from "./src/server.ts";
import {
  createOllamaHandler,
  checkOllamaAvailable,
  ensureModel,
} from "./src/ollama.ts";
import { createOpenAICompatHandler } from "./src/openai-compat.ts";
import { loadOpenClawConfig, resolveModel, resolveBindAddress, resolveEnvVars } from "./src/config.ts";
import { McpClientManager, type McpConfig } from "./src/mcp-client.ts";
import { existsSync } from "fs";
import { resolve } from "path";

const useOllama = process.argv.includes("--ollama");
const modelArg = process.argv.find((_, i, a) => a[i - 1] === "--model");
const configArg = process.argv.find((_, i, a) => a[i - 1] === "--config");

// --mcp [path]  — path is optional; falls back to mcp.json in script dir
const mcpFlagIdx = process.argv.indexOf("--mcp");
const mcpArg = mcpFlagIdx !== -1
  ? (process.argv[mcpFlagIdx + 1]?.startsWith("--") ? undefined : process.argv[mcpFlagIdx + 1])
  : undefined;
const useMcp = mcpFlagIdx !== -1;
const ollamaModel = process.env["OLLAMA_MODEL"] ?? "qwen3:4b";
const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";

// Load config early so gateway settings and env vars apply before server creation
const earlyConfig = await loadOpenClawConfig(import.meta.dir, configArg);
const gwConfig = earlyConfig?.gateway;

const server = new MiniClawServer({
  port: gwConfig?.port ?? 8080,
  hostname: resolveBindAddress(gwConfig?.bind),
  authToken: gwConfig?.auth?.token ? resolveEnvVars(gwConfig.auth.token) : undefined,
  authPassword: gwConfig?.auth?.password ? resolveEnvVars(gwConfig.auth.password) : undefined,
});

let mcpManager: McpClientManager | undefined;

// ── Load MCP tools (shared between --ollama and openclaw.json modes) ────────

async function loadMcpManager(): Promise<McpClientManager | undefined> {
  // Collect servers from openclaw.json mcp.servers section
  const configServers = earlyConfig?.mcp?.servers ?? {};

  // Collect servers from standalone mcp.json (--mcp flag)
  let fileServers: McpConfig["mcpServers"] = {};
  if (useMcp) {
    const mcpConfigPath = mcpArg ? resolve(mcpArg) : resolve(import.meta.dir, "mcp.json");
    if (!existsSync(mcpConfigPath)) {
      console.warn(`--mcp specified but ${mcpConfigPath} not found. Continuing without MCP tools.`);
    } else {
      try {
        const raw = await Bun.file(mcpConfigPath).text();
        const parsed = JSON.parse(raw) as McpConfig;
        fileServers = parsed.mcpServers;
      } catch (err) {
        console.warn("Failed to load mcp.json:", err);
      }
    }
  }

  // Merge: openclaw.json takes precedence over mcp.json for same-named servers
  const merged = { ...fileServers, ...configServers };
  if (Object.keys(merged).length === 0) return undefined;

  try {
    const manager = new McpClientManager({ mcpServers: merged });
    await manager.connect();
    console.log(
      `MCP: ${manager.connectedServerCount} server(s), ${manager.totalToolCount} tool(s)`
    );
    return manager;
  } catch (err) {
    console.warn("Failed to initialize MCP manager:", err);
    return undefined;
  }
}

// ── Provider Setup ──────────────────────────────────────────────────────────

async function setupProvider() {
  mcpManager = await loadMcpManager();

  // 1. Explicit --ollama flag: use Ollama native API
  if (useOllama) {
    console.log(`Checking Ollama at ${ollamaBaseUrl}...`);

    const available = await checkOllamaAvailable(ollamaBaseUrl);
    if (!available) {
      console.warn(`WARNING: Ollama not reachable at ${ollamaBaseUrl}. Falling back to demo mode.`);
      console.warn("  Start Ollama with: ollama serve");
      return;
    }

    const modelReady = await ensureModel(ollamaBaseUrl, ollamaModel);
    if (!modelReady) {
      console.warn(`WARNING: Model "${ollamaModel}" not found. Falling back to demo mode.`);
      console.warn(`  Pull it with: ollama pull ${ollamaModel}`);
      return;
    }

    server.onAgentRun = createOllamaHandler(
      server,
      { baseUrl: ollamaBaseUrl, model: ollamaModel },
      mcpManager
    );
    server.currentModel = ollamaModel;
    server.currentProvider = "ollama";
    console.log(`Ollama mode enabled (model: ${ollamaModel})`);
    return;
  }

  // 2. Try openclaw.json for provider config (reuse already-loaded config)
  const openclawConfig = earlyConfig;
  if (!openclawConfig) return; // No config found — stay in demo mode

  const resolved = resolveModel(openclawConfig, modelArg);
  if (!resolved) {
    if (modelArg) {
      console.warn(`WARNING: Could not resolve model "${modelArg}" from openclaw.json.`);
    }
    return;
  }

  if (resolved.provider.api !== "openai-completions") {
    console.warn(
      `WARNING: Provider "${resolved.providerName}" uses unsupported api "${resolved.provider.api}". Only "openai-completions" is supported.`
    );
    return;
  }

  server.onAgentRun = createOpenAICompatHandler(
    server,
    {
      baseUrl: resolved.provider.baseUrl,
      apiKey: resolved.provider.apiKey,
      model: resolved.modelId,
    },
    mcpManager
  );
  server.currentModel = `${resolved.providerName}/${resolved.modelId}`;
  server.currentProvider = resolved.providerName;
  console.log(
    `OpenAI-compat mode: ${resolved.displayName} via ${resolved.providerName} (${resolved.provider.baseUrl})`
  );
}

await setupProvider();

const srv = server.start();
const mode = server.onAgentRun
  ? `${server.currentProvider}${mcpManager ? "+mcp" : ""}`
  : "demo";
console.log(`MiniClaw server listening on ws://localhost:${srv.port} [${mode}]`);

// Cleanup on exit
process.on("SIGINT", async () => {
  await mcpManager?.close();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await mcpManager?.close();
  server.stop();
  process.exit(0);
});

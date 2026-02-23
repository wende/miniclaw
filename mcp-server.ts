import { MiniClawServer } from "./src/server.ts";
import {
  createOllamaHandler,
  checkOllamaAvailable,
  ensureModel,
} from "./src/ollama.ts";
import { createOpenAICompatHandler } from "./src/openai-compat.ts";
import { loadOpenClawConfig, resolveModel } from "./src/config.ts";
import { createMcpServer, startMcpStdio } from "./src/mcp-server.ts";
import { McpClientManager, type McpConfig } from "./src/mcp-client.ts";
import { existsSync } from "fs";
import { resolve } from "path";

const ollamaModel = process.env["OLLAMA_MODEL"] ?? "qwen3:4b";
const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const wsPort = parseInt(process.env["MINICLAW_PORT"] ?? "8080", 10);

// ── Start MiniClaw server (WebSocket) ───────────────────────────────────────

const server = new MiniClawServer({
  port: wsPort,
  hostname: "0.0.0.0",
});

// ── Load MCP client config (optional) ───────────────────────────────────────

let mcpManager: McpClientManager | undefined;
const mcpConfigPath = resolve(import.meta.dir, "mcp.json");

if (existsSync(mcpConfigPath)) {
  try {
    const raw = await Bun.file(mcpConfigPath).text();
    const config: McpConfig = JSON.parse(raw);
    mcpManager = new McpClientManager(config);
    await mcpManager.connect();
    console.error(
      `MCP client: ${mcpManager.connectedServerCount} server(s), ${mcpManager.totalToolCount} tool(s)`
    );
  } catch (err) {
    console.error("Failed to load mcp.json:", err);
  }
}

// ── Setup model handler ─────────────────────────────────────────────────────

// Try openclaw.json first, fall back to Ollama native API
const openclawConfig = await loadOpenClawConfig(import.meta.dir);
const resolved = openclawConfig ? resolveModel(openclawConfig) : null;

if (resolved && resolved.provider.api === "openai-completions") {
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
  console.error(
    `OpenAI-compat: ${resolved.displayName} via ${resolved.providerName}`
  );
} else {
  // Fall back to Ollama native API
  const available = await checkOllamaAvailable(ollamaBaseUrl);
  if (available) {
    const modelReady = await ensureModel(ollamaBaseUrl, ollamaModel);
    if (modelReady) {
      server.onAgentRun = createOllamaHandler(
        server,
        { baseUrl: ollamaBaseUrl, model: ollamaModel },
        mcpManager
      );
      server.currentModel = ollamaModel;
      server.currentProvider = "ollama";
      console.error(`Ollama mode enabled (model: ${ollamaModel})`);
    } else {
      console.error(`WARNING: Model "${ollamaModel}" not found. Using demo mode.`);
    }
  } else {
    console.error(`WARNING: Ollama not reachable at ${ollamaBaseUrl}. Using demo mode.`);
  }
}

// ── Start WebSocket server ──────────────────────────────────────────────────

const srv = server.start();
console.error(`MiniClaw WebSocket on ws://localhost:${srv.port}`);

// ── Start MCP stdio server ──────────────────────────────────────────────────

const mcpServer = createMcpServer(server);
await startMcpStdio(mcpServer);

// ── Cleanup ─────────────────────────────────────────────────────────────────

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

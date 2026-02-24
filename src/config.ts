import { existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

// ── OpenClaw Config Types ───────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  api: "openai-completions" | "anthropic-messages";
  models: ModelEntry[];
}

// ── Gateway Config (§gateway) ───────────────────────────────────────────────

export type BindMode = "loopback" | "lan" | "auto" | "tailnet" | "custom";

export interface GatewayAuthConfig {
  mode?: "none" | "token" | "password" | "trusted-proxy";
  token?: string;
  password?: string;
}

export interface GatewayConfig {
  port?: number;
  bind?: BindMode;
  auth?: GatewayAuthConfig;
}

// ── Env Config (§env) ────────────────────────────────────────────────────────

export interface EnvConfig {
  vars?: Record<string, string>;
  shellEnv?: { enabled?: boolean; timeoutMs?: number };
  [key: string]: unknown;
}

// ── MCP Config (§mcp) ───────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSectionConfig {
  servers: Record<string, McpServerConfig>;
}

// ── Full Config ──────────────────────────────────────────────────────────────

export interface OpenClawConfig {
  gateway?: GatewayConfig;
  env?: EnvConfig;
  mcp?: McpSectionConfig;
  agents?: {
    defaults?: {
      model?: {
        primary?: string; // "provider/model-id"
      };
      systemPrompt?: string;
    };
  };
  models?: {
    providers?: Record<string, ProviderConfig>;
  };
}

// ── Model Reference ─────────────────────────────────────────────────────────

export interface ResolvedModel {
  provider: ProviderConfig;
  providerName: string;
  modelId: string;
  displayName: string;
}

export function parseModelRef(ref: string): { providerName: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return { providerName: ref, modelId: "" };
  }
  return { providerName: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

// ── Bind Address Resolution ─────────────────────────────────────────────────

export function resolveBindAddress(bind?: BindMode): string {
  switch (bind) {
    case "lan":
      return "0.0.0.0";
    case "loopback":
      return "127.0.0.1";
    // tailnet, auto, custom: fall back to loopback (miniclaw doesn't manage Tailscale)
    default:
      return "127.0.0.1";
  }
}

// ── Env Var Injection ────────────────────────────────────────────────────────

function applyEnvConfig(env: EnvConfig): void {
  for (const [key, value] of Object.entries(env)) {
    if (key === "vars" && typeof value === "object" && value !== null) {
      for (const [varName, varValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof varValue === "string" && !process.env[varName]) {
          process.env[varName] = varValue;
        }
      }
    } else if (key !== "shellEnv" && typeof value === "string" && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ── Env Var Substitution ────────────────────────────────────────────────────

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

// ── Config Loader ───────────────────────────────────────────────────────────

// Search order:
//   1. Explicit path (--config flag or OPENCLAW_CONFIG_PATH env var)
//   2. Local dir openclaw.json
//   3. ~/.openclaw/openclaw.json
function findConfigPath(dir: string, explicit?: string): string | null {
  if (explicit) {
    const p = resolve(explicit);
    if (existsSync(p)) return p;
    console.warn(`Config file not found: ${p}`);
    return null;
  }

  const envPath = process.env["OPENCLAW_CONFIG_PATH"];
  if (envPath) {
    const p = resolve(envPath);
    if (existsSync(p)) return p;
    console.warn(`OPENCLAW_CONFIG_PATH not found: ${p}`);
    return null;
  }

  const local = resolve(dir, "openclaw.json");
  if (existsSync(local)) return local;

  const global = resolve(homedir(), ".openclaw", "openclaw.json");
  if (existsSync(global)) return global;

  return null;
}

export async function loadOpenClawConfig(
  dir: string,
  explicit?: string
): Promise<OpenClawConfig | null> {
  const configPath = findConfigPath(dir, explicit);
  if (!configPath) return null;

  const raw = await Bun.file(configPath).text();
  const config = JSON.parse(raw) as OpenClawConfig;

  // Apply env section before any ${VAR} substitution (only fills missing keys)
  if (config.env) {
    applyEnvConfig(config.env);
  }

  return config;
}

export function resolveModel(
  config: OpenClawConfig,
  modelRef?: string
): ResolvedModel | null {
  const ref = modelRef ?? config.agents?.defaults?.model?.primary;
  if (!ref) return null;

  const { providerName, modelId } = parseModelRef(ref);
  const provider = config.models?.providers?.[providerName];
  if (!provider) return null;

  // Resolve env vars in apiKey
  const resolved: ProviderConfig = {
    ...provider,
    apiKey: provider.apiKey ? resolveEnvVars(provider.apiKey) : undefined,
    baseUrl: resolveEnvVars(provider.baseUrl),
  };

  // Find the model entry (or use the modelId directly if not listed)
  const modelEntry = provider.models.find((m) => m.id === modelId);
  const displayName = modelEntry?.name ?? modelId;

  return {
    provider: resolved,
    providerName,
    modelId: modelId || provider.models[0]?.id || "",
    displayName,
  };
}

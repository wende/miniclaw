import { existsSync } from "fs";
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

export interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: string; // "provider/model-id"
      };
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

// ── Env Var Substitution ────────────────────────────────────────────────────

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

// ── Config Loader ───────────────────────────────────────────────────────────

export async function loadOpenClawConfig(dir: string): Promise<OpenClawConfig | null> {
  const configPath = resolve(dir, "openclaw.json");
  if (!existsSync(configPath)) return null;

  const raw = await Bun.file(configPath).text();
  return JSON.parse(raw) as OpenClawConfig;
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

import type { ServerWebSocket } from "bun";
import type { MiniClawServer, Run, HistoryEntry } from "./server.ts";
import type { ContentPart } from "./types.ts";
import type { McpClientManager } from "./mcp-client.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./ollama.ts";

// ── Config ───────────────────────────────────────────────────────────────────

export interface GeminiConfig {
  apiKey: string;
  model: string;
  systemPrompt?: string;
  reasoning?: boolean;
}

// ── History Conversion ────────────────────────────────────────────────────────

function historyToGeminiContents(history: HistoryEntry[]) {
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const entry of history) {
    if (entry.stopReason === "greeting") continue;
    const role = entry.role === "assistant" ? "model" : "user";
    const text = entry.content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
    if (text) contents.push({ role, parts: [{ text }] });
  }
  return contents;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export function createGeminiHandler(
  server: MiniClawServer,
  config: GeminiConfig,
  _mcpManager?: McpClientManager
) {
  return async (run: Run, _ws: ServerWebSocket<unknown> | null) => {
    const signal = run.abortController.signal;

    const history = server.getChatHistory(run.sessionKey);
    const contents = historyToGeminiContents(history);

    server.emitAgentEvent(run, "lifecycle", {
      phase: "start",
      startedAt: Date.now(),
    });

    const body: Record<string, unknown> = {
      system_instruction: {
        parts: [{ text: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }],
      },
      contents,
    };

    if (config.reasoning) {
      body["generationConfig"] = {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      };
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let leftover = "";
    let textAccumulated = "";
    let thinkingAccumulated = "";
    let lastChatDeltaAt = 0;

    while (true) {
      if (signal.aborted) {
        reader.cancel();
        run.state = "aborted";
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      leftover += decoder.decode(value, { stream: true });
      const lines = leftover.split("\n");
      leftover = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        let chunk: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
        try { chunk = JSON.parse(trimmed.slice(6)); } catch { continue; }

        for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
          if (!part.text) continue;
          if (part.thought) {
            thinkingAccumulated += part.text;
            server.emitAgentEvent(run, "thinking", {
              text: thinkingAccumulated,
              delta: part.text,
            });
          } else {
            textAccumulated += part.text;
            run.accumulatedText = textAccumulated;
            server.emitAgentEvent(run, "assistant", {
              text: textAccumulated,
              delta: part.text,
            });
            const now = Date.now();
            if (now - lastChatDeltaAt >= 150) {
              server.emitChatEvent(run, "delta", textAccumulated);
              lastChatDeltaAt = now;
            }
          }
        }
      }
    }

    if (textAccumulated) {
      server.emitChatEvent(run, "delta", textAccumulated);
    }

    const contentParts: ContentPart[] = [];
    if (thinkingAccumulated) {
      contentParts.push({ type: "thinking", thinking: thinkingAccumulated });
    }
    if (textAccumulated) {
      contentParts.push({ type: "text", text: textAccumulated });
    }

    server.finishRun(run, "completed", undefined, contentParts);
  };
}

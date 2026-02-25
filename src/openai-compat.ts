import type { ServerWebSocket } from "bun";
import type { MiniClawServer, Run, HistoryEntry } from "./server.ts";
import type { ContentPart } from "./types.ts";
import type { McpClientManager, OllamaTool } from "./mcp-client.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./ollama.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface OpenAICompatConfig {
  baseUrl: string; // e.g. "http://localhost:11434/v1"
  apiKey?: string;
  model: string;
  systemPrompt?: string;
  reasoning?: boolean;
}

// ── Message Types ───────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ── Stream Types ────────────────────────────────────────────────────────────

interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: StreamToolCallDelta[];
}

interface StreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
}

// ── OpenAI Chat Completions API ─────────────────────────────────────────────

async function openaiChat(
  config: OpenAICompatConfig,
  messages: OpenAIMessage[],
  tools: OllamaTool[] | undefined,
  signal: AbortSignal
): Promise<ReadableStream<StreamChunk>> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };

  if (tools && tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI-compat API error ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error("OpenAI-compat API returned no response body");
  }

  // Parse SSE stream into typed chunks
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";

  return new ReadableStream<StreamChunk>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (leftover.trim()) {
            for (const line of leftover.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
                try {
                  controller.enqueue(JSON.parse(trimmed.slice(6)));
                } catch { /* skip */ }
              }
            }
          }
          controller.close();
          return;
        }

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop()!;

        let enqueued = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              controller.enqueue(JSON.parse(trimmed.slice(6)));
              enqueued = true;
            } catch { /* skip malformed */ }
          }
        }

        if (enqueued) return;
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ── History Conversion ──────────────────────────────────────────────────────

function historyToOpenAIMessages(history: HistoryEntry[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const entry of history) {
    if (entry.stopReason === "greeting" || entry.stopReason === "slash") continue;
    if (entry.role === "user") {
      const text = entry.content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
      if (text) messages.push({ role: "user", content: text });
    } else if (entry.role === "assistant") {
      const text = entry.content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
      if (text) messages.push({ role: "assistant", content: text });
    }
  }

  return messages;
}

// ── Accumulate Streamed Tool Calls ──────────────────────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function accumulateToolCalls(
  accumulated: Map<number, AccumulatedToolCall>,
  deltas: StreamToolCallDelta[]
) {
  for (const delta of deltas) {
    let entry = accumulated.get(delta.index);
    if (!entry) {
      entry = { id: delta.id ?? "", name: "", arguments: "" };
      accumulated.set(delta.index, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name += delta.function.name;
    if (delta.function?.arguments) entry.arguments += delta.function.arguments;
  }
}

// ── Main Handler ────────────────────────────────────────────────────────────

export function createOpenAICompatHandler(
  server: MiniClawServer,
  config: OpenAICompatConfig,
  mcpManager?: McpClientManager
) {
  const allTools: OllamaTool[] = mcpManager ? mcpManager.getOllamaTools() : [];

  return async (run: Run, _ws: ServerWebSocket<unknown> | null) => {
    const signal = run.abortController.signal;

    // Build messages from chat history
    const history = server.getChatHistory(run.sessionKey);
    const historyMessages = historyToOpenAIMessages(history);
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      },
      ...historyMessages,
    ];

    // When noHistory is enabled, appendHistory is a no-op so the current
    // user message never makes it into history. Ensure it is always present.
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== run.message) {
      messages.push({ role: "user", content: run.message });
    }

    // Emit lifecycle start
    server.emitAgentEvent(run, "lifecycle", {
      phase: "start",
      startedAt: Date.now(),
    });

    const contentParts: ContentPart[] = [];
    let toolCallCounter = 0;

    // Tool call loop
    let iteration = 0;
    const MAX_ITERATIONS = 10;

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      if (signal.aborted) {
        run.state = "aborted";
        return;
      }

      const stream = await openaiChat(config, messages, allTools, signal);
      const reader = stream.getReader();

      let fullContent = "";
      let textAccumulated = "";
      let lastChatDeltaAt = 0;
      const toolCallAccumulator = new Map<number, AccumulatedToolCall>();

      // Read the stream
      while (true) {
        if (signal.aborted) {
          reader.cancel();
          run.state = "aborted";
          return;
        }

        const { done, value: chunk } = await reader.read();
        if (done) break;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Accumulate tool call deltas
        if (delta.tool_calls) {
          accumulateToolCalls(toolCallAccumulator, delta.tool_calls);
        }

        // Stream text content
        if (delta.content) {
          fullContent += delta.content;
          textAccumulated += delta.content;
          run.accumulatedText = textAccumulated;

          server.emitAgentEvent(run, "assistant", {
            text: textAccumulated,
            delta: delta.content,
          });

          const now = Date.now();
          if (now - lastChatDeltaAt >= 150) {
            server.emitChatEvent(run, "delta", textAccumulated);
            lastChatDeltaAt = now;
          }
        }
      }

      // Check if the model made tool calls
      const toolCalls = Array.from(toolCallAccumulator.values());

      if (toolCalls.length > 0) {
        // Build the assistant message with tool_calls for conversation history
        const assistantMsg: OpenAIMessage = {
          role: "assistant",
          content: fullContent || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
        messages.push(assistantMsg);

        for (const tc of toolCalls) {
          toolCallCounter++;
          const toolCallId = tc.id || `tc_${run.runId}_${toolCallCounter}`;
          const name = tc.name;

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            args = {};
          }

          // Emit tool start
          server.emitAgentEvent(run, "tool", {
            phase: "start",
            name,
            toolCallId,
            args,
          });

          // Execute tool via MCP
          let result: string;
          let isError: boolean;

          if (mcpManager && mcpManager.isNamespacedTool(name)) {
            const mcpResult = await mcpManager.callTool(name, args);
            result = mcpResult.result;
            isError = mcpResult.isError;
          } else {
            result = JSON.stringify({ error: `Unknown tool: ${name}` });
            isError = true;
          }

          // Emit tool result
          server.emitAgentEvent(run, "tool", {
            phase: "result",
            name,
            toolCallId,
            result,
            isError,
          });

          // Add to content parts for history
          contentParts.push({
            type: "tool_call",
            name,
            toolCallId,
            arguments: JSON.stringify(args),
            status: isError ? "error" : "success",
            result,
            resultError: isError,
          });

          // Append tool result message (OpenAI format requires tool_call_id)
          messages.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
          });
        }

        // Continue the loop — call again with tool results
        continue;
      }

      // No tool calls — text response is complete
      if (textAccumulated) {
        server.emitChatEvent(run, "delta", textAccumulated);
      }

      if (textAccumulated) {
        contentParts.push({ type: "text", text: textAccumulated });
      }

      break;
    }

    if (signal.aborted) {
      run.state = "aborted";
      return;
    }

    server.finishRun(run, "completed", undefined, contentParts);
  };
}

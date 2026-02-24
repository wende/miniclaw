import type { ServerWebSocket } from "bun";
import type { MiniClawServer, Run, HistoryEntry } from "./server.ts";
import type { ContentPart } from "./types.ts";
import type { McpClientManager, OllamaTool } from "./mcp-client.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  reasoning?: boolean;
  systemPrompt?: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. You can use tools when needed. Be concise and helpful.";

const DEFAULT_CONFIG: OllamaConfig = {
  baseUrl: "http://localhost:11434",
  model: "qwen3:4b",
};

// ── Tool Definitions ────────────────────────────────────────────────────────

export const MOCK_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "echo",
      description: "Echo back the provided text. Useful for testing or repeating information verbatim.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to echo back" },
        },
        required: ["text"],
      },
    },
  },
];

// ── Mock Tool Implementations ───────────────────────────────────────────────

export function executeMockTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "web_search":
      return JSON.stringify({
        results: [
          {
            title: `Search results for "${args["query"]}"`,
            snippet: `Here are some relevant findings about "${args["query"]}". Multiple sources confirm this is a popular topic with extensive documentation available.`,
            url: `https://example.com/search?q=${encodeURIComponent(String(args["query"]))}`,
          },
          {
            title: `${args["query"]} - Wikipedia`,
            snippet: `A comprehensive overview of ${args["query"]}, covering key concepts and recent developments.`,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(args["query"]))}`,
          },
        ],
      });

    case "read_file":
      return `// Contents of ${args["path"]}\nexport const config = {\n  debug: false,\n  port: 3000,\n};\n`;

    case "execute_command":
      return `$ ${args["command"]}\nCommand executed successfully.\nExit code: 0`;

    case "echo":
      return String(args["text"] ?? "");

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Ollama Chat API ─────────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaStreamChunk {
  message?: { role: string; content: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
}

async function ollamaChat(
  config: OllamaConfig,
  messages: OllamaMessage[],
  tools: OllamaTool[] | undefined,
  signal: AbortSignal
): Promise<ReadableStream<OllamaStreamChunk>> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };
  if (config.reasoning) {
    body["think"] = true;
  }
  if (tools && tools.length > 0) {
    body["tools"] = tools;
  }

  const res = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama API error ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error("Ollama returned no response body");
  }

  // Transform the NDJSON stream into parsed objects
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";

  return new ReadableStream<OllamaStreamChunk>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Process any leftover
          if (leftover.trim()) {
            try {
              controller.enqueue(JSON.parse(leftover));
            } catch { /* ignore trailing junk */ }
          }
          controller.close();
          return;
        }

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop()!; // last element may be incomplete

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            controller.enqueue(JSON.parse(trimmed));
          } catch { /* skip malformed lines */ }
        }

        // If we enqueued at least one chunk, return to let consumer process
        if (lines.length > 1 || (lines.length === 1 && lines[0]!.trim())) {
          return;
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ── History Conversion ──────────────────────────────────────────────────────

function historyToOllamaMessages(history: HistoryEntry[]): OllamaMessage[] {
  const messages: OllamaMessage[] = [];

  for (const entry of history) {
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

// ── Main Handler ────────────────────────────────────────────────────────────

export function createOllamaHandler(
  server: MiniClawServer,
  config?: Partial<OllamaConfig>,
  mcpManager?: McpClientManager
) {
  const cfg: OllamaConfig = { ...DEFAULT_CONFIG, ...config };

  // Build tool list: MCP tools (if any) + built-in mock tools
  const allTools: OllamaTool[] = [
    ...(mcpManager ? mcpManager.getOllamaTools() : []),
    ...MOCK_TOOLS,
  ];

  return async (run: Run, _ws: ServerWebSocket<unknown> | null) => {
    const signal = run.abortController.signal;

    // Build messages from chat history
    const history = server.getChatHistory(run.sessionKey);
    const messages: OllamaMessage[] = [
      {
        role: "system",
        content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      },
      ...historyToOllamaMessages(history),
    ];

    // Emit lifecycle start
    server.emitAgentEvent(run, "lifecycle", {
      phase: "start",
      startedAt: Date.now(),
    });

    const contentParts: ContentPart[] = [];
    let toolCallCounter = 0;

    // Tool call loop — keep calling Ollama until it generates text without tool_calls
    let iteration = 0;
    const MAX_ITERATIONS = 10;

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      if (signal.aborted) {
        run.state = "aborted";
        return;
      }

      // On first iteration, use tools. On subsequent iterations, also use tools
      // since the model may chain multiple tool calls.
      const stream = await ollamaChat(cfg, messages, allTools, signal);
      const reader = stream.getReader();

      let fullContent = "";
      const toolCalls: OllamaToolCall[] = [];
      let thinkingAccumulated = "";
      let textAccumulated = "";
      let lastChatDeltaAt = 0;

      // Read the stream
      while (true) {
        if (signal.aborted) {
          reader.cancel();
          run.state = "aborted";
          return;
        }

        const { done, value: chunk } = await reader.read();
        if (done) break;

        if (chunk.message?.tool_calls) {
          toolCalls.push(...chunk.message.tool_calls);
        }

        // Ollama streams thinking via a separate `thinking` field
        if (chunk.message?.thinking) {
          thinkingAccumulated += chunk.message.thinking;
          run.accumulatedThinking = thinkingAccumulated;
          server.emitAgentEvent(run, "reasoning", {
            text: thinkingAccumulated,
            delta: chunk.message.thinking,
          });
        }

        if (chunk.message?.content) {
          fullContent += chunk.message.content;
          textAccumulated += chunk.message.content;
          run.accumulatedText = textAccumulated;

          server.emitAgentEvent(run, "assistant", {
            text: textAccumulated,
            delta: chunk.message.content,
          });

          // Throttle chat deltas to ~150ms
          const now = Date.now();
          if (now - lastChatDeltaAt >= 150) {
            server.emitChatEvent(run, "delta", textAccumulated);
            lastChatDeltaAt = now;
          }
        }
      }

      // If model made tool calls, execute them and loop
      if (toolCalls.length > 0) {
        // Append assistant message with tool_calls to conversation
        messages.push({
          role: "assistant",
          content: fullContent,
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          toolCallCounter++;
          const toolCallId = `tc_${run.runId}_${toolCallCounter}`;
          const name = tc.function.name;
          const args = tc.function.arguments;

          // Emit tool start
          server.emitAgentEvent(run, "tool", {
            phase: "start",
            name,
            toolCallId,
            args,
          });

          // Execute tool: MCP if namespaced, otherwise mock
          let result: string;
          let isError = false;

          if (mcpManager && mcpManager.isNamespacedTool(name)) {
            const mcpResult = await mcpManager.callTool(name, args);
            result = mcpResult.result;
            isError = mcpResult.isError;
          } else {
            result = executeMockTool(name, args);
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

          // Append tool result message
          messages.push({
            role: "tool",
            content: result,
          });
        }

        // Continue the loop — call Ollama again with tool results
        continue;
      }

      // No tool calls — text response is complete
      // Ensure a final chat delta is emitted
      if (textAccumulated) {
        server.emitChatEvent(run, "delta", textAccumulated);
      }

      // Add thinking and text to content parts for history
      if (thinkingAccumulated) {
        contentParts.push({ type: "thinking", thinking: thinkingAccumulated });
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

    // Finish the run
    server.finishRun(run, "completed", undefined, contentParts);
  };
}

// ── Health Check ────────────────────────────────────────────────────────────

export async function checkOllamaAvailable(
  baseUrl: string = DEFAULT_CONFIG.baseUrl
): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureModel(
  baseUrl: string = DEFAULT_CONFIG.baseUrl,
  model: string = DEFAULT_CONFIG.model
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

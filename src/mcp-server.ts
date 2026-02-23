import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MiniClawServer } from "./server.ts";

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "chat",
    description:
      "Send a message to the Ollama model and get a response. Supports multi-turn conversation via sessionKey.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message to send to the model" },
        sessionKey: {
          type: "string",
          description: "Session key for conversation continuity (default: 'main')",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "clear_session",
    description: "Clear a chat session's history",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionKey: {
          type: "string",
          description: "Session key to clear (default: 'main')",
        },
      },
    },
  },
  {
    name: "list_models",
    description: "List the current model and provider",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ── Setup ───────────────────────────────────────────────────────────────────

export function createMcpServer(miniclawServer: MiniClawServer): Server {
  const mcpServer = new Server(
    { name: "miniclaw", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "chat": {
        const message = (args as Record<string, unknown>)?.["message"] as string;
        if (!message) {
          return {
            content: [{ type: "text", text: "Error: message is required" }],
            isError: true,
          };
        }
        const sessionKey =
          ((args as Record<string, unknown>)?.["sessionKey"] as string) ?? "main";

        const response = await miniclawServer.chatAndWait(sessionKey, message);
        return { content: [{ type: "text", text: response }] };
      }

      case "clear_session": {
        const sessionKey =
          ((args as Record<string, unknown>)?.["sessionKey"] as string) ?? "main";
        miniclawServer.clearSession(sessionKey);
        return {
          content: [{ type: "text", text: `Session "${sessionKey}" cleared.` }],
        };
      }

      case "list_models": {
        const text = `Model: ${miniclawServer.currentModel}\nProvider: ${miniclawServer.currentProvider}`;
        return { content: [{ type: "text", text }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return mcpServer;
}

export async function startMcpStdio(mcpServer: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

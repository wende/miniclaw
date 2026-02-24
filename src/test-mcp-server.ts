#!/usr/bin/env bun
/**
 * Minimal MCP server for integration testing of McpClientManager.
 * Exposes two tools: "echo" (returns its input) and "add" (adds two numbers).
 * Communicates via stdio transport.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "test-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Returns the input message",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to echo back" },
        },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Adds two numbers",
      inputSchema: {
        type: "object" as const,
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "echo": {
      const message = (args as Record<string, unknown>)?.["message"] as string;
      return { content: [{ type: "text", text: message ?? "" }] };
    }
    case "add": {
      const a = (args as Record<string, unknown>)?.["a"] as number;
      const b = (args as Record<string, unknown>)?.["b"] as number;
      return { content: [{ type: "text", text: String((a ?? 0) + (b ?? 0)) }] };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

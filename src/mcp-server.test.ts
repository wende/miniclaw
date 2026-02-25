import { describe, test, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.ts";
import { MiniClawServer } from "./server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: MiniClawServer;
let portCounter = 19_300;

function nextPort() {
  return portCounter++;
}

function createServer(overrides?: Record<string, unknown>) {
  const port = nextPort();
  server = new MiniClawServer({
    port,
    hostname: "127.0.0.1",
    tickIntervalMs: 600_000,
    healthRefreshIntervalMs: 600_000,
    ...overrides,
  });
  server.start();
  return server;
}

async function createMcpClient(srv: MiniClawServer) {
  const mcpServer = createMcpServer(srv);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-mcp-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, mcpServer };
}

afterEach(() => {
  server?.stop();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MCP Server — ListTools", () => {
  test("returns all 3 tools", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    const { tools } = await client.listTools();

    expect(tools.length).toBe(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("chat");
    expect(names).toContain("clear_session");
    expect(names).toContain("list_models");

    await client.close();
  });
});

describe("MCP Server — chat tool", () => {
  test("sends a message and gets a response", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    const result = await client.callTool({
      name: "chat",
      arguments: { message: "Hello" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.length).toBeGreaterThan(0);
    const firstContent = content[0]!;
    expect(firstContent.type).toBe("text");
    expect(firstContent.text!.length).toBeGreaterThan(0);
    expect(result.isError).toBeFalsy();

    await client.close();
  });

  test("missing message param returns error", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    const result = await client.callTool({
      name: "chat",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const firstContent = content[0]!;
    expect(firstContent.text).toContain("message is required");

    await client.close();
  });

  test("custom sessionKey works", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    await client.callTool({
      name: "chat",
      arguments: { message: "Hello custom", sessionKey: "custom-session" },
    });

    const history = srv.getChatHistory("custom-session");
    expect(history.length).toBe(2); // user + assistant
    const firstHistoryItem = history[0]!;
    expect(firstHistoryItem.role).toBe("user");
    expect(firstHistoryItem.content[0]!.text).toBe("Hello custom");

    await client.close();
  });
});

describe("MCP Server — clear_session tool", () => {
  test("clears session history", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    // Send a message to create history
    await client.callTool({
      name: "chat",
      arguments: { message: "test", sessionKey: "clear-test" },
    });
    expect(srv.getChatHistory("clear-test").length).toBeGreaterThan(0);

    // Clear
    const result = await client.callTool({
      name: "clear_session",
      arguments: { sessionKey: "clear-test" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const firstContent = content[0]!;
    expect(firstContent.text).toContain("clear-test");
    expect(firstContent.text).toContain("cleared");
    expect(srv.getChatHistory("clear-test").length).toBe(0);

    await client.close();
  });

  test("defaults to 'main' session", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    // Send a message to main session
    await client.callTool({
      name: "chat",
      arguments: { message: "test" },
    });
    expect(srv.getChatHistory("main").length).toBeGreaterThan(0);

    // Clear with no sessionKey
    const result = await client.callTool({
      name: "clear_session",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const firstContent = content[0]!;
    expect(firstContent.text).toContain("main");
    expect(srv.getChatHistory("main").length).toBe(0);

    await client.close();
  });
});

describe("MCP Server — list_models tool", () => {
  test("returns current model and provider", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    const result = await client.callTool({
      name: "list_models",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const firstContent = content[0]!;
    expect(firstContent.text).toContain("Model:");
    expect(firstContent.text).toContain("Provider:");
    expect(firstContent.text).toContain(srv.currentModel);
    expect(firstContent.text).toContain(srv.currentProvider);

    await client.close();
  });
});

describe("MCP Server — unknown tool", () => {
  test("returns error with isError: true", async () => {
    const srv = createServer();
    const { client } = await createMcpClient(srv);

    const result = await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const firstContent = content[0]!;
    expect(firstContent.text).toContain("Unknown tool");
    expect(firstContent.text).toContain("nonexistent_tool");

    await client.close();
  });
});

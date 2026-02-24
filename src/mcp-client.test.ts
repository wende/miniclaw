import { describe, test, expect, afterEach } from "bun:test";
import { McpClientManager } from "./mcp-client.ts";
import { resolve, join } from "path";
import { homedir } from "os";

const BUN = join(homedir(), ".bun", "bin", "bun");

// ── Unit Tests (no subprocess) ───────────────────────────────────────────────

describe("McpClientManager — unit", () => {
  test("isNamespacedTool returns true for server__tool", () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    expect(mgr.isNamespacedTool("server__tool")).toBe(true);
  });

  test("isNamespacedTool returns false for plain tool name", () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    expect(mgr.isNamespacedTool("tool")).toBe(false);
  });

  test("connectedServerCount returns 0 initially", () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    expect(mgr.connectedServerCount).toBe(0);
  });

  test("totalToolCount returns 0 initially", () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    expect(mgr.totalToolCount).toBe(0);
  });

  test("getOllamaTools returns empty array with no servers", () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    expect(mgr.getOllamaTools()).toEqual([]);
  });

  test("callTool with non-namespaced name returns error", async () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    const result = await mgr.callTool("plainname", {});
    expect(result.isError).toBe(true);
    expect(result.result).toContain("not a namespaced MCP tool");
  });

  test("callTool with unknown server returns error", async () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    const result = await mgr.callTool("unknown__tool", {});
    expect(result.isError).toBe(true);
    expect(result.result).toContain('MCP server "unknown" not found');
  });

  test("close on empty manager does not throw", async () => {
    const mgr = new McpClientManager({ mcpServers: {} });
    await mgr.close(); // should not throw
  });
});

// ── Integration Tests (real subprocess) ──────────────────────────────────────

const TEST_SERVER_PATH = resolve(import.meta.dir, "test-mcp-server.ts");

describe("McpClientManager — integration", () => {
  let mgr: McpClientManager;

  afterEach(async () => {
    await mgr?.close();
  });

  test("connect to test MCP server", async () => {
    mgr = new McpClientManager({
      mcpServers: {
        testserver: {
          command: BUN,
          args: ["run", TEST_SERVER_PATH],
        },
      },
    });

    await mgr.connect();

    expect(mgr.connectedServerCount).toBe(1);
    expect(mgr.totalToolCount).toBe(2); // echo + add
  });

  test("getOllamaTools returns properly namespaced tools", async () => {
    mgr = new McpClientManager({
      mcpServers: {
        testserver: {
          command: BUN,
          args: ["run", TEST_SERVER_PATH],
        },
      },
    });

    await mgr.connect();

    const tools = mgr.getOllamaTools();
    expect(tools.length).toBe(2);

    const names = tools.map((t) => t.function.name);
    expect(names).toContain("testserver__echo");
    expect(names).toContain("testserver__add");

    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.description).toBeString();
      expect(tool.function.parameters).toBeDefined();
    }
  });

  test("callTool invokes echo and returns result", async () => {
    mgr = new McpClientManager({
      mcpServers: {
        testserver: {
          command: BUN,
          args: ["run", TEST_SERVER_PATH],
        },
      },
    });

    await mgr.connect();

    const result = await mgr.callTool("testserver__echo", { message: "hello world" });
    expect(result.isError).toBe(false);
    expect(result.result).toBe("hello world");
  });

  test("callTool invokes add and returns result", async () => {
    mgr = new McpClientManager({
      mcpServers: {
        testserver: {
          command: BUN,
          args: ["run", TEST_SERVER_PATH],
        },
      },
    });

    await mgr.connect();

    const result = await mgr.callTool("testserver__add", { a: 3, b: 4 });
    expect(result.isError).toBe(false);
    expect(result.result).toBe("7");
  });

  test("close shuts down cleanly", async () => {
    mgr = new McpClientManager({
      mcpServers: {
        testserver: {
          command: BUN,
          args: ["run", TEST_SERVER_PATH],
        },
      },
    });

    await mgr.connect();
    expect(mgr.connectedServerCount).toBe(1);

    await mgr.close();
    expect(mgr.connectedServerCount).toBe(0);
    expect(mgr.totalToolCount).toBe(0);
  });
});

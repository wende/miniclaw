import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

// ── Tool Types ──────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ── McpClientManager ────────────────────────────────────────────────────────

export class McpClientManager {
  private config: McpConfig;
  private servers = new Map<string, ServerEntry>();

  constructor(config: McpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const entries = Object.entries(this.config.mcpServers);

    for (const [name, serverConfig] of entries) {
      try {
        const client = new Client(
          { name: `miniclaw-${name}`, version: "1.0.0" },
          { capabilities: {} }
        );

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
            ? { ...process.env, ...serverConfig.env } as Record<string, string>
            : undefined,
        });

        await client.connect(transport);

        const { tools } = await client.listTools();

        this.servers.set(name, { client, transport, tools });

        console.log(
          `MCP server "${name}" connected — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`
        );
      } catch (err) {
        console.error(`Failed to connect to MCP server "${name}":`, err);
      }
    }
  }

  getOllamaTools(): OllamaTool[] {
    const tools: OllamaTool[] = [];

    for (const [serverName, entry] of this.servers) {
      for (const tool of entry.tools) {
        tools.push({
          type: "function",
          function: {
            name: `${serverName}__${tool.name}`,
            description: tool.description ?? "",
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
      }
    }

    return tools;
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>
  ): Promise<{ result: string; isError: boolean }> {
    const separatorIndex = namespacedName.indexOf("__");
    if (separatorIndex === -1) {
      return { result: `Error: "${namespacedName}" is not a namespaced MCP tool`, isError: true };
    }

    const serverName = namespacedName.slice(0, separatorIndex);
    const toolName = namespacedName.slice(separatorIndex + 2);

    const entry = this.servers.get(serverName);
    if (!entry) {
      return { result: `Error: MCP server "${serverName}" not found`, isError: true };
    }

    try {
      const response = await entry.client.callTool({
        name: toolName,
        arguments: args,
      });

      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      return {
        result: text || JSON.stringify(response.content),
        isError: response.isError === true,
      };
    } catch (err) {
      return { result: `Error calling tool "${toolName}": ${err}`, isError: true };
    }
  }

  isNamespacedTool(name: string): boolean {
    return name.includes("__");
  }

  get connectedServerCount(): number {
    return this.servers.size;
  }

  get totalToolCount(): number {
    let count = 0;
    for (const entry of this.servers.values()) {
      count += entry.tools.length;
    }
    return count;
  }

  async close(): Promise<void> {
    for (const [name, entry] of this.servers) {
      try {
        await entry.transport.close();
      } catch (err) {
        console.error(`Error closing MCP server "${name}":`, err);
      }
    }
    this.servers.clear();
  }
}

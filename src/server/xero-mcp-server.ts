import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ToolFactory } from "../tools/tool-factory.js";
import { DebugWhoamiTool } from "../tools/debug-whoami.tool.js";

export class XeroMcpServer {
  private static instance: McpServer | null = null;

  private constructor() {}

  /**
   * Singleton accessor — used by the stdio entry point where one Node process
   * serves a single MCP client (Claude Desktop pattern).
   */
  public static GetServer(): McpServer {
    if (XeroMcpServer.instance === null) {
      XeroMcpServer.instance = new McpServer({
        name: "Xero MCP Server",
        version: "1.0.0",
      });
    }
    return XeroMcpServer.instance;
  }

  /**
   * Mira fork addition: factory that builds a fresh McpServer with all tools
   * registered. The HTTP transport instantiates one of these per session so
   * sessions are isolated. Tools themselves use the Proxy-based `xeroClient`
   * which resolves the per-request auth context from AsyncLocalStorage, so
   * multiple sessions safely share the same handler code.
   */
  public static CreateServer(): McpServer {
    const server = new McpServer({
      name: "Xero MCP Server",
      version: "1.0.0",
    });
    ToolFactory(server);
    // Debug tool to verify per-request AsyncLocalStorage isolation (HTTP
    // mode only — never registered for stdio). Safe to leave registered;
    // it only echoes back the requesting context's tenantId.
    const whoami = DebugWhoamiTool();
    server.tool(whoami.name, whoami.description, whoami.schema, whoami.handler);
    return server;
  }
}

#!/usr/bin/env node

// Mira fork entry point.
//
// Two transport modes:
//   - stdio (default): upstream Claude-Desktop pattern, one process per user,
//     credentials from XERO_CLIENT_ID/SECRET or XERO_CLIENT_BEARER_TOKEN env.
//   - http: Streamable HTTP server (MCP spec). Each request carries
//     `Authorization: Bearer <token>` and `xero-tenant-id: <uuid>`. The
//     middleware stashes a per-request XeroClient in AsyncLocalStorage and
//     the Proxy-based `xeroClient` export in clients/xero-client.ts routes
//     every handler call through it. One Node process safely serves many
//     users concurrently.
//
// Choose mode with `--transport http|stdio` (default stdio) or
// MCP_TRANSPORT env var.

import { randomUUID } from "crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { XeroMcpServer } from "./server/xero-mcp-server.js";
import { ToolFactory } from "./tools/tool-factory.js";
import { authContext, authContextFromHeaders } from "./perRequestAuth.js";

interface CliArgs {
  transport: "stdio" | "http";
  httpPort: number;
  httpHost: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let transport: string | undefined;
  let httpPort = 3101;
  let httpHost = "0.0.0.0";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--transport" && i + 1 < args.length) {
      transport = args[++i];
    } else if (arg === "--port" && i + 1 < args.length) {
      httpPort = Number(args[++i]);
    } else if (arg === "--host" && i + 1 < args.length) {
      httpHost = args[++i];
    }
  }

  const resolvedTransport =
    transport || process.env.MCP_TRANSPORT || "stdio";
  if (resolvedTransport !== "stdio" && resolvedTransport !== "http") {
    console.error(
      `Invalid transport: ${resolvedTransport}. Must be "stdio" or "http".`,
    );
    process.exit(1);
  }
  return {
    transport: resolvedTransport,
    httpPort,
    httpHost,
  };
}

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
    : `[${timestamp}] ${message}`;
  console.error(line);
}

// ---------------------------------------------------------------------------
// stdio transport (upstream default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = XeroMcpServer.GetServer();
  ToolFactory(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// HTTP transport (Mira fork — multi-user)
// ---------------------------------------------------------------------------

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function startHttpTransport(args: CliArgs): Promise<void> {
  const { httpPort, httpHost } = args;
  console.error(
    `Starting Xero MCP server (HTTP on ${httpHost}:${httpPort})...`,
  );

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  const sessions = new Map<string, HttpSession>();
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function resetSessionTimer(sid: string) {
    const existing = sessionTimers.get(sid);
    if (existing) clearTimeout(existing);
    sessionTimers.set(
      sid,
      setTimeout(async () => {
        const session = sessions.get(sid);
        if (session) {
          log(`Session idle timeout: ${sid}`);
          await session.transport.close();
          await session.server.close();
          sessions.delete(sid);
        }
        sessionTimers.delete(sid);
      }, SESSION_IDLE_TIMEOUT_MS),
    );
  }

  function clearSessionTimer(sid: string) {
    const timer = sessionTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      sessionTimers.delete(sid);
    }
  }

  // Health check — MiraEngine can probe this to verify the sidecar is up
  // without needing a valid Bearer token.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, transport: "http" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    // Require Bearer token + xero-tenant-id on every POST. The token is a
    // Xero OAuth access token owned by the calling user; tenantId scopes
    // every Xero API call to a specific organisation.
    const ctx = authContextFromHeaders(
      req.headers.authorization,
      req.headers["xero-tenant-id"] as string | undefined,
    );
    if (!ctx) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Unauthorized: missing or invalid Bearer token or xero-tenant-id header",
        },
        id: null,
      });
      return;
    }

    await authContext.run(ctx, async () => {
      try {
        const sessionId = req.headers["mcp-session-id"] as
          | string
          | undefined;

        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          resetSessionTimer(sessionId);
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message:
                "Bad Request: expected initialize request or valid session ID",
            },
            id: null,
          });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const sessionServer = XeroMcpServer.CreateServer();
        await sessionServer.connect(transport);

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            clearSessionTimer(sid);
            sessions.delete(sid);
            log(`Session closed: ${sid}`);
          }
        };

        await transport.handleRequest(req, res, req.body);

        const sid = transport.sessionId;
        if (sid) {
          sessions.set(sid, { transport, server: sessionServer });
          resetSessionTimer(sid);
          log(`New session created: ${sid}`);
        }
      } catch (error) {
        log("Error handling POST /mcp", {
          error: (error as Error).message,
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    // GET is for SSE streams on an existing session — also requires the
    // per-request auth context because the same handler code runs.
    const ctx = authContextFromHeaders(
      req.headers.authorization,
      req.headers["xero-tenant-id"] as string | undefined,
    );
    if (!ctx) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Unauthorized: missing or invalid Bearer token or xero-tenant-id header",
        },
        id: null,
      });
      return;
    }
    await authContext.run(ctx, async () => {
      try {
        const sessionId = req.headers["mcp-session-id"] as
          | string
          | undefined;
        if (!sessionId || !sessions.has(sessionId)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Bad Request: missing or invalid session ID",
            },
            id: null,
          });
          return;
        }
        const session = sessions.get(sessionId)!;
        resetSessionTimer(sessionId);
        await session.transport.handleRequest(req, res);
      } catch (error) {
        log("Error handling GET /mcp", {
          error: (error as Error).message,
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Bad Request: missing or invalid session ID",
          },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId)!;
      await session.transport.close();
      await session.server.close();
      sessions.delete(sessionId);
      res.status(200).end();
    } catch (error) {
      log("Error handling DELETE /mcp", {
        error: (error as Error).message,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(httpPort, httpHost, () => {
    log(`HTTP server listening on ${httpHost}:${httpPort}`);
  });

  const shutdown = async () => {
    log("Shutting down HTTP server...");
    for (const [sid, session] of sessions) {
      await session.transport.close();
      await session.server.close();
      sessions.delete(sid);
    }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const main = async () => {
  const args = parseArgs();
  if (args.transport === "http") {
    await startHttpTransport(args);
  } else {
    await startStdioTransport();
  }
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

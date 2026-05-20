// Mira fork addition.
// Debug-only tool that proves the per-request AsyncLocalStorage context is
// isolated across concurrent requests. Two simultaneous calls with different
// tenants must each see ONLY their own tenant — both before and after
// awaiting a delay. If either response shows the other request's tenant,
// we have a cross-user data leak and must abort the deploy.
//
// Registered only by `XeroMcpServer.CreateServer()` (HTTP mode). Never wired
// into the stdio entry point.

import { z } from "zod";

import { CreateXeroTool } from "../helpers/create-xero-tool.js";
import { authContext } from "../perRequestAuth.js";

const DebugWhoamiTool = CreateXeroTool(
  "debug-whoami",
  "Debug tool: returns the per-request auth context (tenantId) read at entry, then again after an optional delay, to verify AsyncLocalStorage isolation across concurrent multi-tenant requests. Safe to expose — only echoes back what the request already carried.",
  {
    delay_ms: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe("Sleep this many ms inside the handler before re-reading the context. Use to interleave concurrent calls and prove they don't collide."),
    label: z
      .string()
      .max(64)
      .optional()
      .describe("Caller-supplied label echoed back, makes pairing requests with responses easy in test scripts."),
  },
  async (params: { delay_ms?: number; label?: string }) => {
    const delay = params.delay_ms ?? 0;
    const label = params.label ?? null;

    const before = authContext.getStore();
    const beforeTenant = before?.tenantId ?? null;
    const tokenSeen = before?.client ? "present" : "missing";

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const after = authContext.getStore();
    const afterTenant = after?.tenantId ?? null;

    const isolated = beforeTenant === afterTenant && beforeTenant !== null;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              label,
              beforeTenant,
              afterTenant,
              isolated,
              tokenSeen,
              delay_ms: delay,
              pid: process.pid,
              ts: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

export { DebugWhoamiTool };

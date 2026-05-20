# Mira fork notes

This repo is the upstream [@xeroapi/xero-mcp-server](https://github.com/XeroAPI/xero-mcp-server) patched for multi-user HTTP deployment behind MiraEngine.

## What changed

The upstream server is **stdio-only and single-tenant** — one Node process per Claude Desktop user, credentials baked in via environment variables. We need one process serving many MiraEngine users concurrently, each with their own Xero org.

The fork keeps every handler (~50 tools) byte-identical and changes only the auth substrate underneath.

### New files

- `src/perRequestAuth.ts` — `AsyncLocalStorage` carrying a per-request `PerRequestXeroClient` + tenantId.
- `Dockerfile.mira` — multi-stage build, runs HTTP transport on port 3101.

### Modified files

- `src/clients/xero-client.ts` — the exported `xeroClient` is now a `Proxy`. Every property access (`xeroClient.tenantId`, `xeroClient.accountingApi.X(...)`, `xeroClient.authenticate()`) resolves against the per-request client from AsyncLocalStorage. Falls back to the legacy env-var-backed client only if no AsyncLocalStorage context exists (stdio mode).
- `src/server/xero-mcp-server.ts` — added `CreateServer()` factory so HTTP mode can instantiate one fresh `McpServer` per session. Singleton `GetServer()` preserved for stdio.
- `src/index.ts` — added HTTP transport mode (`StreamableHTTPServerTransport` + Express). Selectable via `--transport http|stdio` or `MCP_TRANSPORT` env. Stdio mode unchanged.
- `package.json` — added `express`, `cors`, types. Added `start:http` script.

### Unchanged

Every file in `src/handlers/`, `src/tools/`, `src/helpers/`, `src/types/`, `src/consts/`. The Proxy makes the 52 handler files multi-tenant safe without touching them.

## Auth contract

In HTTP mode every request (POST/GET /mcp) must include:

```
Authorization: Bearer <xero_access_token>
xero-tenant-id: <tenantId_uuid>
```

The token is a standard Xero OAuth2 access token. MiraEngine owns the OAuth flow, refresh lifecycle, and tenant selection — this server is a stateless proxy. The token is injected into the per-request XeroClient via `setTokenSet({ access_token })`; we never call `authenticate()` or any token endpoint from here.

## Why a Proxy (and not refactor every handler)

Upstream handlers call `xeroClient.tenantId` and `xeroClient.accountingApi.X(...)` directly across 52 files. Refactoring each to `getRequestClient().X(...)` would be mechanical but high-risk — easy to miss a call site, and merge conflicts on upstream sync are guaranteed.

The Proxy makes the same `xeroClient` export behave as a per-request object via AsyncLocalStorage. Zero handler changes, zero merge-conflict surface against upstream.

## Building locally

```bash
npm install
npm run build
npm run start:http       # port 3101
# stdio mode (upstream compatibility):
node dist/index.js       # no --transport flag = stdio
```

## Deployment

Patterned exactly on `MiraHub/google-drive-mcp` — own ACA Container App with internal ingress, scale-to-zero. See `MiraEngine/cicd/deployment.md` for the Drive playbook; replicate with `s/drive/xero/`, `s/3100/3101/`.

## Risks / sharp edges

- **`xero-node` library state.** The Xero SDK internally caches `tokenSet` on the client instance. Our `PerRequestXeroClient` constructs a fresh instance per HTTP request, so no token sharing between users. If a future SDK version moves to module-level state, the Proxy approach breaks.
- **`xeroClient.getShortCode()`** caches `shortCode` on the instance. Per-request instance = per-request cache, so it re-fetches on every call. Negligible cost — one extra Xero call per session in the worst case. If it becomes a hotspot, hoist to a per-tenant in-memory cache keyed by `tenantId`.
- **No `authenticate()` re-entry.** Some handlers still call `await xeroClient.authenticate()` defensively — this is now a no-op in HTTP mode. If a future upstream patch starts relying on `authenticate()` side effects beyond `setTokenSet`, revisit.

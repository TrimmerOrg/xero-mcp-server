// Mira fork addition.
// Per-request auth context carried via AsyncLocalStorage so the same Node
// process can serve many users concurrently without colliding on the global
// xeroClient singleton.
//
// The HTTP handler reads `Authorization: Bearer <token>` and
// `xero-tenant-id: <uuid>` off each request, builds a per-request
// PerRequestXeroClient, and runs the rest of the work inside
// `authContext.run()`. The Proxy-based `xeroClient` export from
// `./clients/xero-client` then resolves all property access against the
// per-request instance pulled from AsyncLocalStorage — every handler stays
// unchanged.

import { AsyncLocalStorage } from "async_hooks";
import { XeroClient } from "xero-node";

export interface RequestAuthContext {
  client: PerRequestXeroClient;
  tenantId: string;
}

export const authContext = new AsyncLocalStorage<RequestAuthContext>();

/**
 * XeroClient subclass that's pre-populated with a bearer token + tenantId
 * from the HTTP request headers. `authenticate()` is a no-op because the
 * caller (MiraEngine) owns OAuth — the token is already valid and the
 * tenantId already known.
 */
export class PerRequestXeroClient extends XeroClient {
  public tenantId: string;

  constructor(bearerToken: string, tenantId: string) {
    super();
    this.tenantId = tenantId;
    this.setTokenSet({
      access_token: bearerToken,
      token_type: "Bearer",
    });
  }

  // Override the abstract pattern used by upstream clients. In HTTP mode the
  // token is already injected at construction time; there's nothing to do.
  public async authenticate(): Promise<void> {
    return;
  }
}

/**
 * Extract Bearer token + xero-tenant-id from request headers and build a
 * per-request client. Returns null if either header is missing/invalid.
 */
export function authContextFromHeaders(
  authorization: string | undefined,
  tenantHeader: string | undefined,
): RequestAuthContext | null {
  if (!authorization || !tenantHeader) return null;
  const token = authorization.trim().replace(/^Bearer\s+/i, "");
  const tenantId = tenantHeader.trim();
  if (!token || !tenantId) return null;
  const client = new PerRequestXeroClient(token, tenantId);
  return { client, tenantId };
}

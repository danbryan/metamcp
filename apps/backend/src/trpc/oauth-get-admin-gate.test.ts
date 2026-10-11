/**
 * `frontend.oauth.get` must be operator-gated.
 *
 * Fork adaptation of upstream's oauth-get-admin-gate test (#99). Upstream
 * gates this on a users.role RBAC column; this fork runs a single-operator
 * deployment, so `adminProcedure` (`packages/trpc/src/trpc.ts`) accepts any
 * authenticated session and rejects anonymous callers. The impl takes only an
 * `mcp_server_uuid` and returns raw stored credentials (tokens, client
 * secret, code_verifier) unredacted, so the anonymous path must never reach
 * it; the anonymous caller gets UNAUTHORIZED and the impl is never invoked.
 */

import { createOAuthRouter } from "@repo/trpc";
import { describe, expect, it, vi } from "vitest";

const operatorCtx = {
  user: { id: "operator-1", email: "operator@example.com" },
  session: { id: "s-operator" },
};

const MCP_SERVER_UUID = "11111111-1111-4111-8111-111111111111";

const buildRouter = () => {
  const get = vi.fn().mockResolvedValue({
    success: true as const,
    data: {
      uuid: "22222222-2222-4222-8222-222222222222",
      mcp_server_uuid: MCP_SERVER_UUID,
      client_information: {
        client_id: "upstream-client",
        client_secret: "upstream-secret",
      },
      tokens: {
        access_token: "at-secret",
        refresh_token: "rt-secret",
        token_type: "Bearer",
      },
      code_verifier: "cv-secret",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    message: "ok",
  });
  const upsert = vi.fn().mockResolvedValue({
    success: false as const,
    error: "not used in this suite",
  });
  return { router: createOAuthRouter({ get, upsert }), get };
};

describe("oauth.get — operator gate", () => {
  it("authenticated operator allowed", async () => {
    const { router, get } = buildRouter();

    const result = await router
      .createCaller(operatorCtx)
      .get({ mcp_server_uuid: MCP_SERVER_UUID });

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("an unauthenticated caller is UNAUTHORIZED, and the impl is never reached", async () => {
    const { router, get } = buildRouter();

    await expect(
      router.createCaller({}).get({ mcp_server_uuid: MCP_SERVER_UUID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // No credential read may happen at all — the gate must short-circuit
    // before the repository query, not filter the response afterwards.
    expect(get).not.toHaveBeenCalled();
  });
});

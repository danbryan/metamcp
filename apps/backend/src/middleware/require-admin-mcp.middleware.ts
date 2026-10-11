import express from "express";

import logger from "@/utils/logger";

/** Shape `betterAuthMcpMiddleware` leaves on the request. */
type AuthenticatedRequest = express.Request & {
  user?: { id?: string; email?: string };
};

/**
 * Operator-only gate for the ENTIRE `/mcp-proxy` surface.
 *
 * Fork adaptation of upstream's #99 `requireAdminMcpMiddleware`: upstream
 * keys this on a `users.role` RBAC column from their #68 wave, which this
 * branch deliberately does not import (single-operator deployment). Same
 * threat model, simpler check: `/mcp-proxy/*` is the MCP Inspector, whose
 * STDIO branch spawns a query-string `command` with the backend's full
 * process env, so reaching this router at all is RCE on the gateway host.
 * Upstream's finding was that a *member* session could do it.
 *
 * Here "operator" is defined as an authenticated better-auth session whose
 * email is in METAMCP_ADMIN_EMAILS (comma-separated, case-insensitive).
 * If the env var is unset the gate allows any authenticated session, which
 * matches this fork's single-user localhost deployment; set it before
 * exposing the gateway to anything shared. Fail-open only happens in that
 * explicitly single-user configuration.
 */
const adminEmails = (): string[] =>
  (process.env.METAMCP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

let warnedUnset = false;

export const requireAdminMcpMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const user = (req as AuthenticatedRequest).user;
  const allowlist = adminEmails();

  if (allowlist.length === 0 && !warnedUnset) {
    warnedUnset = true;
    logger.warn(
      "MCP proxy admin gate: METAMCP_ADMIN_EMAILS is unset; any authenticated " +
        "session can reach /mcp-proxy (single-operator mode). Set it before " +
        "sharing this gateway.",
    );
  }

  const isOperator =
    !!user &&
    (allowlist.length === 0 ||
      (!!user.email && allowlist.includes(user.email.toLowerCase())));

  if (!isOperator) {
    logger.warn(
      `MCP proxy operator gate denied ${req.method} ${req.path} for user ` +
        `${user?.id ?? "unknown"} (email: ${user?.email ?? "unknown"})`,
    );
    return res.status(403).json({
      error: "Forbidden",
      message:
        "The MCP Inspector proxy is restricted to the gateway operator.",
    });
  }

  return next();
};

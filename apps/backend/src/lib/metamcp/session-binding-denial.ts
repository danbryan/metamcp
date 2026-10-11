/**
 * The shared refusal surface for a session reuse the ownership guards reject.
 *
 * Both public-endpoint routers refuse the same class of request — a live
 * `Mcp-Session-Id` presented on an endpoint it does not belong to, or under a
 * credential that did not create it — across four legs: streamable-http's
 * request lookup, its DELETE guard's resident and not-resident branches, and
 * sse's `/message` leg. Every one of them answers 404. This module holds the
 * three things all four need, so a refusal cannot be recorded one way on one
 * leg and another way on the next:
 *
 *  - `extractPresentedCredential` — which raw credential this request carried,
 *  - `recordSessionBindingDenial` — whether this refusal gets written down,
 *  - `emitSessionBindingDenial` — the `mcp.auth.denied` envelope itself.
 *
 * It lives under `lib/metamcp/` rather than in either router because sse.ts
 * importing streamable-http.ts would drag in that module's boot side effects
 * (the sweeper, the hydration contract assertion, its session manager).
 */

import { createHash } from "node:crypto";

import type { DatabaseEndpoint } from "@repo/zod-types";
import express from "express";

import logger from "@/utils/logger";

import type { SessionBindingDenialReason } from "../session-lifetime-manager";

// Fork adaptation: upstream emits these denials into an immutable audit_log
// table (their #105 wave, lib/audit/audit-emitter.ts), which this branch does
// not import. Same event surface, different sink: a throttled warn log plus a
// test sink seam. If this fork ever takes the audit wave, re-point `emit` at
// audit_log rows.
function credentialFingerprint(
  credential: string | undefined,
): { sha256: string; last4: string } | null {
  if (!credential) return null;
  return {
    sha256: createHash("sha256").update(credential).digest("hex").slice(0, 12),
    last4: credential.slice(-4),
  };
}

type DenialEvent = {
  actor_id: string | null;
  actor_type: "user" | "api_key" | "anonymous";
  action: "mcp.auth.denied";
  outcome: "denied";
  target_id: string | null;
  http_status: 404;
  detail: Record<string, unknown>;
};

let denialSink: (event: DenialEvent) => void = (event) => {
  logger.warn(
    `mcp.auth.denied (${event.detail.reason}): session ${event.detail.session_id} ` +
      `refused for ${event.actor_type} ${event.actor_id ?? "anonymous"} on ` +
      `${event.detail.endpoint_name ?? "unknown endpoint"} ` +
      `(suppressed_since_last=${event.detail.suppressed_since_last})`,
  );
};

/** Test seam mirroring upstream's setAuditSinkForTesting. */
export function setSessionDenialSinkForTesting(
  sink: ((event: DenialEvent) => void) | null,
): void {
  denialSink = sink ?? ((...args: Parameters<typeof denialSink>) => undefined) as never;
  if (!sink) {
    // restore the default logger sink
    denialSink = (event: DenialEvent) => {
      logger.warn(
        `mcp.auth.denied (${event.detail.reason}): session ${event.detail.session_id} ` +
          `refused for ${event.actor_type} ${event.actor_id ?? "anonymous"} on ` +
          `${event.detail.endpoint_name ?? "unknown endpoint"} ` +
          `(suppressed_since_last=${event.detail.suppressed_since_last})`,
      );
    };
  }
}


/**
 * Why a session reuse was refused.
 *
 * The three in-memory reasons are classified by `classifyBindingDenial` next
 * to the predicate that produced them; the fourth belongs to the DELETE guard's
 * not-resident branch, where there is no in-memory binding to classify and the
 * comparison is against the persisted row's `auth_principal` hash instead.
 *
 * This is the field an operator queries to separate the classes, so it must
 * describe what actually failed. A single hardcoded value would report a
 * credential mismatch for a plain cross-endpoint replay, i.e. assert an event
 * that did not happen in the one table that cannot be corrected afterwards.
 */
export type SessionDenialReason =
  | SessionBindingDenialReason
  | "session_persisted_credential_mismatch";

/**
 * Extract the raw bearer token (or API key) the middleware authenticated
 * from. The middleware doesn't surface the matched token explicitly, so
 * we replay the same header lookup it used. Returns `null` when no
 * recognizable credential is present — the lazy-recovery path then
 * refuses recovery (a credential-less request can't reclaim a session).
 *
 * THE QUERY BRANCH IS GATED on the same two endpoint flags `extractAuthToken`
 * uses in `api-key-oauth.middleware`, and must stay gated. This function is
 * load-bearing on three guard paths (lazy recovery, the DELETE persisted-row
 * check, and the credential named in a denial row); reading `?api_key=` on an
 * endpoint that does not accept query-param auth would let an anonymous caller
 * on an `ALLOW_UNAUTHENTICATED_ENDPOINTS` endpoint satisfy a persisted-principal
 * comparison the middleware itself would never have accepted the token for.
 * That needs the victim's raw secret, so it grants no new reach — but the two
 * definitions of "which credential did this request present" diverging is
 * exactly the drift these guards cannot afford.
 */
export function extractPresentedCredential(
  req: express.Request,
  endpoint: DatabaseEndpoint | undefined,
): string | null {
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  const authHeader = req.headers.authorization;
  if (
    typeof authHeader === "string" &&
    authHeader.startsWith("Bearer ") &&
    authHeader.length > 7
  ) {
    return authHeader.substring(7);
  }
  if (endpoint?.enable_api_key_auth && endpoint?.use_query_param_auth) {
    const queryToken =
      (req.query?.api_key as string | undefined) ||
      (req.query?.apikey as string | undefined);
    if (queryToken) {
      return queryToken;
    }
  }
  return null;
}

/**
 * How long one (actor, endpoint, reason) key's refusals collapse into a single
 * audit row, and the ceiling on tracked keys.
 *
 * Same reasoning and same interval as `ACCESS_DENIAL_REPORT_INTERVAL_MS` in
 * `lib/endpoint-access-control`, for the same reason: `audit_log` is made
 * append-only by migration 0028 and has no prune path, so a row's cost is
 * permanent — and this is a row a REFUSED caller controls the rate of. A
 * connector retrying a session id it no longer owns, or an attacker walking
 * ids, would otherwise write one permanent row per attempt at whatever rate it
 * can open sockets. `rateLimitMiddleware` is not a backstop here: both limiters
 * in `lib/rate-limit` engage only once the endpoint carries `max_rate` /
 * `client_max_rate`, which most do not.
 *
 * Suppressed attempts are COUNTED and the count rides on the next row written,
 * so "refused once" and "refused 40,000 times in a minute" stay
 * distinguishable — the question a responder actually asks of this event.
 *
 * PER KEY, not global: one credential hammering one endpoint must not swallow
 * the first refusal seen from a different credential elsewhere, nor the first
 * of a different class from the same caller.
 */
export const SESSION_DENIAL_REPORT_INTERVAL_MS = 60 * 1000;

/** Same ceiling reasoning as the access-denial throttle; same clear-on-overflow. */
export const SESSION_DENIAL_THROTTLE_MAX_ENTRIES = 10_000;

interface DenialThrottleEntry {
  reportedAt: number;
  suppressed: number;
}

/**
 * Separator for the composite throttle key. Same character and same purpose as
 * `KEY_SEPARATOR` in `lib/endpoint-access-control`: NUL cannot appear in a uuid,
 * an endpoint name or a reason, so the parts can never run together into a key
 * two different triples both produce.
 *
 * Written as the ESCAPE, never as a literal NUL in source. A raw NUL byte makes
 * git classify the whole file as binary, which drops it out of `git diff`,
 * `git blame` and the PR review surface entirely — the one thing a module
 * carrying security guards cannot afford to be is unreviewable.
 */
const KEY_SEPARATOR = "\u0000";

const denialThrottle = new Map<string, DenialThrottleEntry>();

/**
 * Should this refusal be written down, and how many were swallowed since the
 * last one that was?
 *
 * Stateful: calling it RECORDS the attempt. Deliberately keyed on the caller
 * and the endpoint but NOT on the session id, so walking a thousand ids under
 * one credential collapses to one row plus a count of 999 rather than to a
 * thousand rows — enumeration is the shape this throttle exists to survive.
 *
 * `reason` IS part of the key, because it is the field an operator queries to
 * tell a cross-endpoint replay apart from a stolen credential. Keying without
 * it would let the first class seen in a window swallow every other class from
 * the same caller into a bare `suppressed_since_last` count — the distinction
 * the reason field exists to carry would be destroyed by the throttle meant to
 * preserve the event. The union has four members, so the ceiling rises from one
 * row to at most four per (actor, endpoint) per window: still bounded, and
 * still driven by classes the server assigns rather than by anything the caller
 * can vary.
 */
export function recordSessionBindingDenial(
  actorKey: string,
  endpointKey: string,
  reason: SessionDenialReason,
): { emit: boolean; suppressed: number } {
  const key = `${actorKey}${KEY_SEPARATOR}${endpointKey}${KEY_SEPARATOR}${reason}`;
  const now = Date.now();
  const entry = denialThrottle.get(key);

  if (entry && now - entry.reportedAt < SESSION_DENIAL_REPORT_INTERVAL_MS) {
    entry.suppressed += 1;
    return { emit: false, suppressed: entry.suppressed };
  }

  if (denialThrottle.size >= SESSION_DENIAL_THROTTLE_MAX_ENTRIES) {
    denialThrottle.clear();
  }
  const suppressed = entry?.suppressed ?? 0;
  denialThrottle.set(key, { reportedAt: now, suppressed: 0 });
  return { emit: true, suppressed };
}

/** Test seam for the throttle map. */
export function __resetSessionDenialThrottleForTesting(): void {
  denialThrottle.clear();
}

/** The identity fields the routers read off `ApiKeyAuthenticatedRequest`. */
interface DenyingRequest extends express.Request {
  endpoint?: DatabaseEndpoint;
  endpointName?: string;
  apiKeyUuid?: string;
  oauthUserId?: string;
  authMethod?: "api_key" | "oauth";
}

/**
 * Durable record of a refused session reuse.
 *
 * Reuses the existing `mcp.auth.denied` verb rather than inventing one: this
 * is a refused credential on the MCP data plane, which is exactly what that
 * action already covers in `api-key-oauth.middleware`, and `detail.reason` is
 * the field an operator queries to separate the classes. A new verb would need
 * every existing query to be widened before it could see this at all.
 *
 * `http_status` is fixed at 404 rather than passed in, because that is the one
 * answer every refusal leg gives: per the MCP Streamable HTTP session model an
 * unknown session id is answered 404 so a well-behaved client re-initializes,
 * and collapsing a refusal into that same answer is what stops the response
 * from confirming someone else's session id is live. A leg that answered
 * anything else would have broken that shaping first.
 *
 * `session_id` is recorded here even though this fork strips session ids from
 * logs, health payloads and client responses. Those are surfaces a consumer or
 * a passer-by can read; `audit_log` is not — `audit-log.repo` exposes `record()`
 * and nothing else, no tRPC procedure reads the table, and migration 0028 makes
 * it append-only. Without the id an operator can see that a session reuse was
 * refused but not which consumer's session was targeted, which is most of what
 * the row is for.
 *
 * Returns the throttle decision so the caller can shape its own warn log the
 * same way instead of logging once per attempt. Fire-and-forget through `emit`,
 * which swallows every failure — a refusal must be answered whether or not it
 * can be recorded.
 */
export function emitSessionBindingDenial(
  req: DenyingRequest,
  denial: { sessionId: string; reason: SessionDenialReason },
): { emitted: boolean; suppressed: number } {
  try {
    const isOAuth = req.authMethod === "oauth";
    const actorId = (isOAuth ? req.oauthUserId : req.apiKeyUuid) ?? null;
    const endpointKey = req.endpoint?.uuid ?? req.endpointName ?? "";
    const { emit: shouldEmit, suppressed } = recordSessionBindingDenial(
      actorId ?? "anonymous",
      endpointKey,
      denial.reason,
    );
    if (!shouldEmit) {
      return { emitted: false, suppressed };
    }

    const xff = req.headers["x-forwarded-for"];
    const actorIp =
      (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ??
      req.socket?.remoteAddress ??
      null;
    denialSink({
      actor_type: isOAuth ? "user" : req.apiKeyUuid ? "api_key" : "anonymous",
      actor_id: actorId,
      action: "mcp.auth.denied",
      outcome: "denied",
      target_id: req.endpoint?.uuid ?? null,
      http_status: 404,
      detail: {
        reason: denial.reason,
        auth_method: req.authMethod ?? null,
        endpoint_name: req.endpointName ?? null,
        endpoint_uuid: req.endpoint?.uuid ?? null,
        actor_ip: actorIp,
        actor_user_agent: req.headers["user-agent"] ?? null,
        session_id: denial.sessionId,
        credential: credentialFingerprint(
          extractPresentedCredential(req, req.endpoint) ?? undefined,
        ),
        // Attempts swallowed by the throttle since the last row was written,
        // so volume survives even though per-attempt timestamps do not.
        suppressed_since_last: suppressed,
      },
    });
    return { emitted: true, suppressed };
  } catch {
    // An audit failure must never change what this guard answers. Same
    // contract as `emitMcpAuthDenial` in api-key-oauth.middleware.
    return { emitted: false, suppressed: 0 };
  }
}

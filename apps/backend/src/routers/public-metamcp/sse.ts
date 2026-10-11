import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";

import {
  ApiKeyAuthenticatedRequest,
  authenticateApiKey,
} from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import logger from "@/utils/logger";

import { metaMcpServerPool } from "../../lib/metamcp/metamcp-server-pool";
import { resolveSessionIdentity } from "../../lib/metamcp/session-auth";
import { emitSessionBindingDenial } from "../../lib/metamcp/session-binding-denial";
import {
  boundSessionMatches,
  classifyBindingDenial,
  SessionBinding,
  SessionBindingDenialReason,
  SessionLifetimeManager,
  SessionLifetimeManagerImpl,
} from "../../lib/session-lifetime-manager";

/**
 * The full binding a request presents — endpoint plus the identity
 * `authenticateApiKey` resolved for it. Ported from upstream #134.
 */
function requestBinding(authReq: ApiKeyAuthenticatedRequest): SessionBinding {
  return {
    namespaceUuid: authReq.namespaceUuid,
    endpointName: authReq.endpointName,
    identity: resolveSessionIdentity(authReq),
  };
}

/**
 * Pure resolver for the `/message` leg's ownership guard. The message must
 * target the SAME endpoint the SSE stream was opened on AND come from the
 * credential that opened it: resolving by sessionId alone would let a caller
 * authenticated for endpoint A post messages into endpoint B's transport, or
 * one consumer post into another consumer's stream on a multi-key endpoint.
 *
 * A missing session and a refused one both resolve to `not_found` so the
 * route's 404 never signals the id is live elsewhere.
 */
export function resolveSseMessageSession(
  manager: Pick<
    SessionLifetimeManager<Transport>,
    "getSession" | "getSessionBinding"
  >,
  sessionId: string,
  target: SessionBinding,
):
  | { outcome: "ok"; transport: Transport }
  | { outcome: "not_found"; refusedReason: SessionBindingDenialReason | null } {
  const transport = manager.getSession(sessionId);
  if (!transport) {
    return { outcome: "not_found", refusedReason: null };
  }
  const binding = manager.getSessionBinding(sessionId);
  if (!boundSessionMatches(binding, target)) {
    return {
      outcome: "not_found",
      refusedReason: classifyBindingDenial(binding, target),
    };
  }
  return { outcome: "ok", transport };
}

/** Record a refused SSE message leg through the throttled denial sink. */
export function refuseSseMessage(
  authReq: ApiKeyAuthenticatedRequest,
  sessionId: string,
  reason: SessionBindingDenialReason,
): void {
  const { emitted, suppressed } = emitSessionBindingDenial(authReq, {
    sessionId,
    reason,
  });
  if (emitted) {
    logger.warn(
      `SSE message for session ${sessionId} on endpoint ${authReq.endpointName} ` +
        `refused (${reason}). ` +
        `${suppressed} similar refusal(s) suppressed since the last line.`,
    );
  }
}

const sseRouter = express.Router();

// Session lifetime manager for SSE sessions
const sessionManager = new SessionLifetimeManagerImpl<Transport>("SSE");

// Cleanup function for a specific session
const cleanupSession = async (sessionId: string, transport?: Transport) => {
  logger.info(`Cleaning up SSE session ${sessionId}`);

  try {
    // Use provided transport or get from session manager
    const sessionTransport = transport || sessionManager.getSession(sessionId);

    if (sessionTransport) {
      logger.info(`Closing transport for session ${sessionId}`);
      await sessionTransport.close();
      logger.info(`Transport cleaned up for session ${sessionId}`);
    } else {
      logger.info(`No transport found for session ${sessionId}`);
    }

    // Remove from session manager
    sessionManager.removeSession(sessionId);

    // Clean up MetaMCP server pool session
    await metaMcpServerPool.cleanupSession(sessionId);

    logger.info(`Session ${sessionId} cleanup completed successfully`);
  } catch (error) {
    logger.error(`Error during cleanup of session ${sessionId}:`, error);
    // Even if cleanup fails, remove the session from manager to prevent memory leaks
    sessionManager.removeSession(sessionId);
    logger.info(`Removed orphaned session ${sessionId} due to cleanup error`);
    throw error;
  }
};

sseRouter.get(
  "/:endpoint_name/sse",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const authReq = req as ApiKeyAuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;

    try {
      logger.info(
        `New public endpoint SSE connection request for ${endpointName} -> namespace ${namespaceUuid}`,
      );

      const webAppTransport = new SSEServerTransport(
        `/metamcp/${endpointName}/message`,
        res,
      );
      logger.info("Created public endpoint SSE transport");

      const sessionId = webAppTransport.sessionId;

      // Get or create MetaMCP server instance from the pool
      const mcpServerInstance = await metaMcpServerPool.getServer(
        sessionId,
        namespaceUuid,
      );
      if (!mcpServerInstance) {
        throw new Error("Failed to get MetaMCP server instance from pool");
      }

      logger.info(
        `Using MetaMCP server instance for public endpoint session ${sessionId}`,
      );

      sessionManager.addSession(
        sessionId,
        webAppTransport,
        requestBinding(req as ApiKeyAuthenticatedRequest),
      );

      // Handle cleanup when connection closes
      res.on("close", async () => {
        logger.info(
          `Public endpoint SSE connection closed for session ${sessionId}`,
        );
        await cleanupSession(sessionId);
      });

      await mcpServerInstance.server.connect(webAppTransport);
    } catch (error) {
      logger.error("Error in public endpoint /sse route:", error);
      res.status(500).json(error);
    }
  },
);

sseRouter.post(
  "/:endpoint_name/message",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    // const authReq = req as ApiKeyAuthenticatedRequest;
    // const { namespaceUuid, endpointName } = authReq;

    try {
      const sessionId = req.query.sessionId;

      // Ownership guard — see resolveSseMessageSession's doc comment.
      const resolution = resolveSseMessageSession(
        sessionManager,
        sessionId as string,
        requestBinding(req as ApiKeyAuthenticatedRequest),
      );
      if (resolution.outcome === "not_found") {
        if (resolution.refusedReason) {
          refuseSseMessage(
            req as ApiKeyAuthenticatedRequest,
            sessionId as string,
            resolution.refusedReason,
          );
        }
        res.status(404).end("Session not found");
        return;
      }
      const transport = resolution.transport as SSEServerTransport;
      await transport.handlePostMessage(req, res);
    } catch (error) {
      logger.error("Error in public endpoint /message route:", error);
      res.status(500).json(error);
    }
  },
);

// Initialize automatic cleanup timer using session manager
sessionManager.startCleanupTimer(async (sessionId, transport) => {
  await cleanupSession(sessionId, transport);
});

export default sseRouter;

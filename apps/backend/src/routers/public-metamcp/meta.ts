/**
 * Gateway-side meta-tool endpoint: /:endpoint_name/meta/mcp
 *
 * Serves exactly three tools (search_tools / describe_tools / call_tool)
 * that proxy the endpoint's full namespace, so ANY MCP client gets lazy
 * tool loading (~2k tokens of schema at session start) without harness
 * support. The pi harness has its own client-side adapter; this route
 * exists for clients that don't (codex, claude, anything else).
 *
 * Deliberately implemented as a thin self-calling layer over the existing
 * public streamable endpoint rather than threading a "meta" flag through
 * the session pools: the upstream session, middleware chain (filtering,
 * overrides, auditing) and lazy recovery all keep working unchanged, and
 * the audit log records the REAL tool names because the forwarded call is
 * an ordinary tools/call on the ordinary endpoint.
 */
import express from "express";

import {
  ApiKeyAuthenticatedRequest,
  authenticateApiKey,
} from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import logger from "@/utils/logger";

const metaRouter = express.Router();

const BACKEND_PORT = process.env.PORT || 12009;

interface UpstreamSession {
  upstreamSessionId: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  credential: string | null;
  endpointName: string;
  lastUsed: number;
}

// Meta session id -> upstream state. Reaped after an hour idle; the
// upstream side has its own persistence and lazy recovery, so losing a
// row here only costs one re-initialize.
const metaSessions = new Map<string, UpstreamSession>();
const META_SESSION_IDLE_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - META_SESSION_IDLE_MS;
  for (const [id, s] of metaSessions) {
    if (s.lastUsed < cutoff) metaSessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

function rawCredential(req: express.Request): string | null {
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  const queryToken =
    (req.query.api_key as string | undefined) ||
    (req.query.apikey as string | undefined);
  return queryToken ?? null;
}

async function upstreamRpc(
  session: UpstreamSession,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (session.credential) headers["X-API-Key"] = session.credential;
  if (session.upstreamSessionId) {
    headers["mcp-session-id"] = session.upstreamSessionId;
  }
  const res = await fetch(
    `http://127.0.0.1:${BACKEND_PORT}/metamcp/${session.endpointName}/mcp`,
    { method: "POST", headers, body: JSON.stringify(payload) },
  );
  session.upstreamSessionId =
    res.headers.get("mcp-session-id") ?? session.upstreamSessionId;
  const body = await res.text();
  if (!body) return null;
  const m = body.match(/^data: (.*)$/m);
  return JSON.parse(m ? m[1] : body);
}

async function ensureUpstream(session: UpstreamSession): Promise<void> {
  if (session.upstreamSessionId && session.tools.length > 0) return;
  await upstreamRpc(session, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "metamcp-meta", version: "1.0.0" },
    },
  });
  await upstreamRpc(session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const listed = await upstreamRpc(session, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  session.tools =
    ((listed?.result as any)?.tools as UpstreamSession["tools"]) ?? [];
}

const META_TOOLS = [
  {
    name: "search_tools",
    description:
      "Search this endpoint's tool catalog by keywords (name and description). " +
      "Returns matching tool names with one-line descriptions. Use an empty " +
      "query to list everything. Then use describe_tools for full schemas " +
      "and call_tool to execute.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to match, e.g. 'create invoice' or 'linear issue'",
        },
        limit: { type: "number", description: "Max results (default 25)" },
      },
    },
  },
  {
    name: "describe_tools",
    description:
      "Return the full input schemas for the named tools. Call this before " +
      "call_tool so the arguments are right on the first try.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Exact tool names from search_tools",
        },
      },
      required: ["names"],
    },
  },
  {
    name: "call_tool",
    description: "Execute one tool from this endpoint with full arguments.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name" },
        arguments: {
          type: "object",
          description: "Arguments matching the tool's schema",
        },
      },
      required: ["name"],
    },
  },
];

function textResult(id: unknown, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }] },
  };
}

async function handleMetaCall(
  session: UpstreamSession,
  id: unknown,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureUpstream(session);

  if (toolName === "search_tools") {
    const query = String(args.query ?? "").toLowerCase().trim();
    const limit = Number(args.limit ?? 25);
    const words = query.split(/\s+/).filter(Boolean);
    const scored = session.tools
      .map((t) => {
        const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        return { t, score: words.length === 0 ? 1 : hits };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const lines = scored.map(
      (x) =>
        `${x.t.name} - ${(x.t.description ?? "").split("\n")[0].slice(0, 120)}`,
    );
    return textResult(
      id,
      lines.length
        ? `${scored.length} of ${session.tools.length} tools:\n${lines.join("\n")}`
        : `No matches among ${session.tools.length} tools. Try broader keywords or an empty query to list all.`,
    );
  }

  if (toolName === "describe_tools") {
    const names = (args.names as string[]) ?? [];
    const found = session.tools.filter((t) => names.includes(t.name));
    const missing = names.filter((n) => !found.some((t) => t.name === n));
    const out: Record<string, unknown> = {};
    for (const t of found) {
      out[t.name] = { description: t.description, inputSchema: t.inputSchema };
    }
    if (missing.length) out["_not_found"] = missing;
    return textResult(id, JSON.stringify(out, null, 1));
  }

  if (toolName === "call_tool") {
    const name = String(args.name ?? "");
    const forwarded = await upstreamRpc(session, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: (args.arguments as object) ?? {} },
    });
    if (forwarded && "result" in forwarded) {
      return { jsonrpc: "2.0", id, result: forwarded.result };
    }
    if (forwarded && "error" in forwarded) {
      return { jsonrpc: "2.0", id, error: forwarded.error };
    }
    return textResult(id, "Upstream returned no response.");
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message: `Unknown meta tool: ${toolName}` },
  };
}

metaRouter.post(
  "/:endpoint_name/meta/mcp",
  express.json({ limit: "50mb" }),
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const authReq = req as ApiKeyAuthenticatedRequest;
    const endpointName = authReq.endpointName;
    const msg = req.body as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: any;
    };

    try {
      if (msg.method === "initialize") {
        const sessionId = crypto.randomUUID();
        metaSessions.set(sessionId, {
          upstreamSessionId: "",
          tools: [],
          credential: rawCredential(req),
          endpointName,
          lastUsed: Date.now(),
        });
        res.setHeader("mcp-session-id", sessionId);
        return res.json({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: `metamcp-meta-${endpointName}`, version: "1.0.0" },
          },
        });
      }

      // Everything below needs a session.
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const session = sessionId ? metaSessions.get(sessionId) : undefined;

      if (msg.method?.startsWith("notifications/")) {
        return res.status(202).end();
      }
      if (!session) {
        return res.status(404).json({
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: -32001, message: "Session not found; re-initialize." },
        });
      }
      session.lastUsed = Date.now();

      if (msg.method === "ping") {
        return res.json({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      if (msg.method === "tools/list") {
        return res.json({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: META_TOOLS },
        });
      }
      if (msg.method === "tools/call") {
        const out = await handleMetaCall(
          session,
          msg.id,
          msg.params?.name,
          msg.params?.arguments ?? {},
        );
        return res.json(out);
      }
      if (
        msg.method === "prompts/list" ||
        msg.method === "resources/list" ||
        msg.method === "resources/templates/list"
      ) {
        const key = msg.method.includes("templates")
          ? "resourceTemplates"
          : msg.method.split("/")[0];
        return res.json({ jsonrpc: "2.0", id: msg.id, result: { [key]: [] } });
      }
      return res.json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32601, message: `Method not supported: ${msg.method}` },
      });
    } catch (error) {
      logger.error(`meta endpoint error for ${endpointName}:`, error);
      return res.status(500).json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32603, message: String(error) },
      });
    }
  },
);

// Streamable HTTP clients probe GET for the SSE channel; we don't push
// server-initiated messages, so refuse politely and they fall back to POST.
metaRouter.get("/:endpoint_name/meta/mcp", (req, res) => {
  res.status(405).end();
});

metaRouter.delete("/:endpoint_name/meta/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) metaSessions.delete(sessionId);
  res.status(204).end();
});

export default metaRouter;

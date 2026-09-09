import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

export const FANTASTICAL_SERVER_UUID = "646228d4-3167-4be1-b3ee-615f8d5c43c2";
export const FANTASTICAL_SERVER_NAME = "fantastical-suggestions";
export const FANTASTICAL_TOOL_NAME = "findAvailableTimes";
export const FANTASTICAL_TIMEOUT_MS = 15_000;
export const FANTASTICAL_COMMAND =
  "/Applications/Fantastical.app/Contents/Helpers/FantasticalMCP.app/Contents/MacOS/FantasticalMCP";
export const FANTASTICAL_QUALIFIED_PREFIX = `${FANTASTICAL_SERVER_NAME}__`;
export const FANTASTICAL_QUALIFIED_TOOL_NAME = `${FANTASTICAL_QUALIFIED_PREFIX}${FANTASTICAL_TOOL_NAME}`;

export class FantasticalPolicyError extends Error {
  readonly nonrecoverable = true;
  constructor(message: string) {
    super(message);
    this.name = "FantasticalPolicyError";
  }
}

export function isReservedFantasticalName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === FANTASTICAL_SERVER_NAME ||
      value.startsWith(FANTASTICAL_QUALIFIED_PREFIX))
  );
}

export function isAllowedFantasticalQualifiedName(value: unknown): boolean {
  return value === FANTASTICAL_QUALIFIED_TOOL_NAME;
}

export function filterFantasticalQualifiedTools<T extends { name: unknown }>(
  tools: T[],
): T[] {
  return tools.filter(
    (tool) =>
      !isReservedFantasticalName(tool.name) ||
      isAllowedFantasticalQualifiedName(tool.name),
  );
}

export function isFantasticalCandidate(server: ServerParameters): boolean {
  return (
    server.uuid === FANTASTICAL_SERVER_UUID ||
    (typeof server.name === "string" &&
      server.name.startsWith(FANTASTICAL_SERVER_NAME)) ||
    server.command === FANTASTICAL_COMMAND
  );
}

function isCanonicalFantastical(server: ServerParameters): boolean {
  return (
    server.uuid === FANTASTICAL_SERVER_UUID &&
    server.name === FANTASTICAL_SERVER_NAME &&
    server.command === FANTASTICAL_COMMAND &&
    server.type === "STDIO"
  );
}

export function assertFantasticalServerIdentity(
  server: ServerParameters,
): void {
  if (isFantasticalCandidate(server) && !isCanonicalFantastical(server)) {
    throw new FantasticalPolicyError(
      "Fantastical server identity is not canonical",
    );
  }
}

function stripHiddenSchemaText(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const schemaMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ]);
  const singleSchemas = new Set([
    "items",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "additionalItems",
    "unevaluatedItems",
    "contentSchema",
  ]);
  const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["description", "title", "examples"].includes(key))
      .map(([key, nested]) => {
        // Property names and literal enum/const/default objects are data, not annotations.
        if (
          schemaMaps.has(key) &&
          nested &&
          typeof nested === "object" &&
          !Array.isArray(nested)
        ) {
          return [
            key,
            Object.fromEntries(
              Object.entries(nested).map(([name, schema]) => [
                name,
                stripHiddenSchemaText(schema),
              ]),
            ),
          ];
        }
        if (schemaArrays.has(key) && Array.isArray(nested))
          return [key, nested.map(stripHiddenSchemaText)];
        if (singleSchemas.has(key))
          return [
            key,
            Array.isArray(nested)
              ? nested.map(stripHiddenSchemaText)
              : stripHiddenSchemaText(nested),
          ];
        return [key, nested];
      }),
  );
}

function schedulingTool(
  tool: Record<string, unknown>,
): Record<string, unknown> {
  const { name, inputSchema, outputSchema, ..._hidden } = tool;
  return {
    name,
    ...(inputSchema === undefined
      ? {}
      : { inputSchema: stripHiddenSchemaText(inputSchema) }),
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: stripHiddenSchemaText(outputSchema) }),
    title: "Find available times",
    description:
      "Suggest conflict-free times for a duration and optional event title/time window, using Fantastical's configured calendars. Unless explicit scope IDs are supplied, history and conflicts use the app's CURRENT calendar set, not necessarily every account. Check that the intended calendars are included and present times in the user's timezone. Suggestions only: this does not reserve or create anything. After the user chooses a time, use the owning Google or Microsoft calendar provider to recheck availability and schedule it.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function installFantasticalRequestGuard(
  client: Client,
  server: ServerParameters,
): void {
  if (!isFantasticalCandidate(server)) return;
  const originalRequest = client.request.bind(client) as Client["request"];
  const canonical = isCanonicalFantastical(server);

  client.request = (async (...args: Parameters<Client["request"]>) => {
    const [request] = args as unknown as [
      { method?: unknown; params?: unknown },
    ];
    const method = request?.method;
    if (
      method !== "initialize" &&
      method !== "ping" &&
      method !== "tools/list" &&
      method !== "tools/call"
    ) {
      throw new FantasticalPolicyError(
        "Fantastical policy rejects this MCP method",
      );
    }
    if (!canonical) {
      if (method === "tools/list") return { tools: [] } as never;
      throw new FantasticalPolicyError(
        "Fantastical server identity is not canonical",
      );
    }
    if (method === "tools/list") {
      const result = (await originalRequest(...args)) as {
        tools?: Record<string, unknown>[];
      };
      return {
        ...result,
        tools: (result.tools ?? [])
          .filter((tool) => tool.name === FANTASTICAL_TOOL_NAME)
          .map(schedulingTool),
      } as never;
    }
    if (method === "tools/call") {
      const params = request.params as
        | {
            name?: unknown;
            task?: unknown;
            _meta?: Record<string, unknown>;
          }
        | undefined;
      if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        params.name !== FANTASTICAL_TOOL_NAME ||
        "task" in params ||
        params._meta?.["io.modelcontextprotocol/related-task"] !== undefined
      ) {
        throw new FantasticalPolicyError(
          "Fantastical policy permits only findAvailableTimes without task augmentation",
        );
      }
      const options = args[2] ?? {};
      args[2] = {
        ...options,
        timeout: Math.min(
          options.timeout ?? FANTASTICAL_TIMEOUT_MS,
          FANTASTICAL_TIMEOUT_MS,
        ),
        maxTotalTimeout: Math.min(
          options.maxTotalTimeout ?? FANTASTICAL_TIMEOUT_MS,
          FANTASTICAL_TIMEOUT_MS,
        ),
        resetTimeoutOnProgress: false,
      };
      const started = performance.now();
      logger.info(
        "[Fantastical policy] Dispatching read-only suggestions request",
      );
      try {
        const result = await originalRequest(...args);
        logger.info(
          `[Fantastical policy] Suggestions response in ${Math.round(performance.now() - started)}ms`,
        );
        return result;
      } catch {
        logger.warn(
          `[Fantastical policy] Suggestions request failed after ${Math.round(performance.now() - started)}ms; not retried`,
        );
        // A tool error result must not enter the gateway's transport-retry cascade.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Fantastical did not return a usable suggestion response. No automatic retry was made. Inspect the native integration before retrying.",
            },
          ],
        } as never;
      }
    }
    return originalRequest(...args);
  }) as Client["request"];
}

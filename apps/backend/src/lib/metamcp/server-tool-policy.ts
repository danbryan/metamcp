import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

export const FANTASTICAL_SERVER_UUID = "646228d4-3167-4be1-b3ee-615f8d5c43c2";
export const FANTASTICAL_SERVER_NAME = "fantastical";
export const FANTASTICAL_TOOL_NAME = "findAvailableTimes";
export const FANTASTICAL_TIMEOUT_MS = 15_000;
export const FANTASTICAL_COMMAND =
  "/Applications/Fantastical.app/Contents/Helpers/FantasticalMCP.app/Contents/MacOS/FantasticalMCP";
export const FANTASTICAL_QUALIFIED_PREFIX = `${FANTASTICAL_SERVER_NAME}__`;
export const FANTASTICAL_QUALIFIED_TOOL_NAME = `${FANTASTICAL_QUALIFIED_PREFIX}${FANTASTICAL_TOOL_NAME}`;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Public metadata is fixed here; upstream descriptions never reach agents.
// deleteCalendarItem is deliberately absent: deletes go through the owning
// Google or Microsoft provider.
export const FANTASTICAL_TOOLS: Record<
  string,
  { title: string; description: string; annotations: Record<string, boolean> }
> = {
  queryCalendars: {
    title: "List calendars",
    description:
      "List every calendar Fantastical sees across Dan's accounts (personal Google, Cosmos Labs Google, Bryanlabs Exchange, iCloud, booking calendars) with id, title, source and whether it is writable. Use the ids for calendarId arguments.",
    annotations: READ_ONLY,
  },
  queryCalendarSets: {
    title: "List calendar sets",
    description:
      "List Fantastical calendar sets (named groups of calendars) with their member calendar ids. Use a set id to scope searches, conflicts or history.",
    annotations: READ_ONLY,
  },
  queryCalendarItems: {
    title: "Search events and tasks",
    description:
      "Find events and tasks by case-insensitive title substring (query), optionally limited by a concrete date range (when, include the year) and by calendarId or calendarSetId (not both). Without a scope it searches the app's current calendar set. Returns item ids for modifyCalendarItem.",
    annotations: READ_ONLY,
  },
  findAvailableTimes: {
    title: "Find available times",
    description:
      "Suggest conflict-free times for durationMinutes (required), with optional natural-language when window (include the year) and title. suggestedTimes are best-first; openTimes are the free stretches. Scope conflicts and pattern history with conflictCalendarId/conflictCalendarSetId and historyCalendarId/historyCalendarSetId; when omitted the app's current calendar set is used. Suggestions only: nothing is reserved. Present times in the user's timezone.",
    annotations: READ_ONLY,
  },
  createCalendarItem: {
    title: "Create an event or task",
    description:
      "Create an event or task from a compact natural-language description (for example 'Dentist Tue Oct 20 2026 2pm for 1 hour'), with optional location and type. calendarId is required by gateway policy: pick the owning calendar with queryCalendars first. There is no attendees field: anything that invites other people goes through the owning Google or Microsoft provider instead. If the time conflicts, ask the user before creating.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  modifyCalendarItem: {
    title: "Update an event or task",
    description:
      "Change the title, time (when, include the year) or location of an existing item by id from queryCalendarItems. Omitted fields stay unchanged; an empty location removes it. If the new time conflicts, ask the user first. Deleting is not available here.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
};

const FANTASTICAL_QUALIFIED_TOOL_NAMES = new Set(
  Object.keys(FANTASTICAL_TOOLS).map(
    (name) => `${FANTASTICAL_QUALIFIED_PREFIX}${name}`,
  ),
);

function isAllowedFantasticalTool(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(FANTASTICAL_TOOLS, value);
}

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
  return (
    typeof value === "string" && FANTASTICAL_QUALIFIED_TOOL_NAMES.has(value)
  );
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

function publicTool(tool: Record<string, unknown>): Record<string, unknown> {
  const { name, inputSchema, outputSchema, ..._hidden } = tool;
  const policy = FANTASTICAL_TOOLS[name as string];
  return {
    name,
    ...(inputSchema === undefined
      ? {}
      : { inputSchema: stripHiddenSchemaText(inputSchema) }),
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: stripHiddenSchemaText(outputSchema) }),
    title: policy.title,
    description: policy.description,
    annotations: policy.annotations,
  };
}

export function installFantasticalRequestGuard(
  client: Client,
  server: ServerParameters,
): void {
  if (!isFantasticalCandidate(server)) return;
  const originalRequest = client.request.bind(client) as Client["request"];
  const canonical = isCanonicalFantastical(server);
  // The helper answers one call per connection at a time; a concurrent call fails after 20s.
  let previousCall: Promise<unknown> = Promise.resolve();
  const serializedRequest = ((...args: Parameters<Client["request"]>) => {
    const call = previousCall.then(() => originalRequest(...args));
    previousCall = call.catch(() => undefined);
    return call;
  }) as Client["request"];

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
          .filter((tool) => isAllowedFantasticalTool(tool.name))
          .map(publicTool),
      } as never;
    }
    if (method === "tools/call") {
      const params = request.params as
        | {
            name?: unknown;
            arguments?: unknown;
            task?: unknown;
            _meta?: Record<string, unknown>;
          }
        | undefined;
      if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        !isAllowedFantasticalTool(params.name) ||
        "task" in params ||
        params._meta?.["io.modelcontextprotocol/related-task"] !== undefined
      ) {
        throw new FantasticalPolicyError(
          "Fantastical policy permits only its listed calendar tools without task augmentation",
        );
      }
      if (params.name === "createCalendarItem") {
        const callArgs = params.arguments as
          | Record<string, unknown>
          | undefined;
        const calendarId = callArgs?.calendarId;
        if (typeof calendarId !== "string" || calendarId.trim() === "") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "createCalendarItem needs calendarId. Choose the owning calendar with queryCalendars (ask the user when it is unclear whether the item is personal or which work account it belongs to), then call again.",
              },
            ],
          } as never;
        }
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
      const toolName = params.name;
      logger.info(`[Fantastical policy] Dispatching ${toolName}`);
      try {
        const result = await serializedRequest(...args);
        logger.info(
          `[Fantastical policy] ${toolName} response in ${Math.round(performance.now() - started)}ms`,
        );
        return result;
      } catch {
        logger.warn(
          `[Fantastical policy] ${toolName} failed after ${Math.round(performance.now() - started)}ms; not retried`,
        );
        // A tool error result must not enter the gateway's transport-retry cascade.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Fantastical did not return a usable response. No automatic retry was made, because a create or modify may already have happened. Check the calendar with queryCalendarItems before retrying.",
            },
          ],
        } as never;
      }
    }
    return originalRequest(...args);
  }) as Client["request"];
}

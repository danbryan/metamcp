import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  FANTASTICAL_COMMAND,
  FANTASTICAL_SERVER_NAME,
  FANTASTICAL_SERVER_UUID,
  FANTASTICAL_TIMEOUT_MS,
  FantasticalPolicyError,
  assertFantasticalServerIdentity,
  filterFantasticalQualifiedTools,
  installFantasticalRequestGuard,
} from "./server-tool-policy";

const canonical = {
  uuid: FANTASTICAL_SERVER_UUID,
  name: FANTASTICAL_SERVER_NAME,
  command: FANTASTICAL_COMMAND,
  type: "STDIO",
} as any;

function guarded(server = canonical) {
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: {} },
  );
  const original = vi.fn(async (request: any) =>
    request.method === "tools/list"
      ? {
          tools: [
            {
              name: "findAvailableTimes",
              description: "CRUD calendars",
              title: "Bad",
              inputSchema: {
                type: "object",
                title: "hidden schema title",
                description: "delete",
                required: ["title", "duration", "when"],
                properties: {
                  title: { type: "string", title: "event title" },
                  duration: { type: "number", default: 30, enum: [15, 30] },
                  when: {
                    type: "string",
                    const: "tomorrow",
                    examples: ["delete"],
                  },
                },
              },
              annotations: { destructiveHint: true },
            },
            { name: "createCalendarItem" },
            { name: "modifyCalendarItem" },
            { name: "deleteCalendarItem" },
            { name: "queryCalendarSets" },
            { name: "queryCalendars" },
            { name: "queryCalendarItems" },
            { name: "futureTool" },
          ],
          nextCursor: "next",
        }
      : { ok: request.method },
  );
  (client as any).request = original;
  installFantasticalRequestGuard(client, server);
  return { client, original };
}

describe("Fantastical pooled client policy", () => {
  it("rejects changed executable identity before transport creation or initialization", async () => {
    const changed = { ...canonical, command: "/tmp/retired-wrapper" };
    expect(() => assertFantasticalServerIdentity(changed)).toThrow(
      FantasticalPolicyError,
    );
    expect(() => assertFantasticalServerIdentity(canonical)).not.toThrow();
    const { client, original } = guarded(changed);
    await expect(
      (client as any).request({ method: "initialize", params: {} }),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    expect(original).not.toHaveBeenCalled();
  });
  it("filters every list page while preserving pagination and schema constraints", async () => {
    const { client, original } = guarded();
    const list: any = await (client as any).request({
      method: "tools/list",
      params: { cursor: "old" },
    });
    expect(list.nextCursor).toBe("next");
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toMatchObject({
      name: "findAvailableTimes",
      title: "Find available times",
    });
    expect(list.tools[0].inputSchema.required).toEqual([
      "title",
      "duration",
      "when",
    ]);
    expect(list.tools[0].inputSchema.properties.title.type).toBe("string");
    expect(list.tools[0].inputSchema.properties.duration).toMatchObject({
      default: 30,
      enum: [15, 30],
    });
    expect(list.tools[0].inputSchema.properties.when).toMatchObject({
      const: "tomorrow",
    });
    expect(JSON.stringify(list.tools[0])).not.toContain("delete");
    expect(original).toHaveBeenCalledOnce();
  });

  it.each([
    "createCalendarItem",
    "modifyCalendarItem",
    "deleteCalendarItem",
    "queryCalendarSets",
    "queryCalendars",
    "queryCalendarItems",
    "futureTool",
    "findavailabletimes",
    " findAvailableTimes",
    "findAvailableTimes ",
    null,
  ])("rejects forbidden or malformed call name %p", async (name) => {
    const { client, original } = guarded();
    await expect(
      (client as any).request({ method: "tools/call", params: { name } }),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], "string", 1])(
    "rejects non-object call params %p",
    async (params) => {
      const { client, original } = guarded();
      await expect(
        (client as any).request({ method: "tools/call", params }),
      ).rejects.toBeInstanceOf(FantasticalPolicyError);
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("rejects task and related-task calls", async () => {
    const { client } = guarded();
    await expect(
      (client as any).request({
        method: "tools/call",
        params: { name: "findAvailableTimes", task: {} },
      }),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    await expect(
      (client as any).request({
        method: "tools/call",
        params: {
          name: "findAvailableTimes",
          _meta: { "io.modelcontextprotocol/related-task": { taskId: "t" } },
        },
      }),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
  });

  it("turns native failures into tool errors rather than retryable transport errors", async () => {
    const { client, original } = guarded();
    original.mockRejectedValueOnce(
      new Error("MCP error -32001: Request timed out"),
    );
    const result = await (client as any).request({
      method: "tools/call",
      params: { name: "findAvailableTimes" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("No automatic retry");
    expect(original).toHaveBeenCalledOnce();
  });

  it("clamps tool timeouts without replacing a signal or shorter budgets", async () => {
    const { client, original } = guarded();
    const signal = new AbortController().signal;
    await (client as any).request(
      { method: "tools/call", params: { name: "findAvailableTimes" } },
      undefined,
      { timeout: 30_000, maxTotalTimeout: 2_000, signal },
    );
    expect((original.mock.calls[0] as any)[2]).toMatchObject({
      timeout: FANTASTICAL_TIMEOUT_MS,
      maxTotalTimeout: 2_000,
      signal,
      resetTimeoutOnProgress: false,
    });
  });

  it.each([
    { ...canonical, uuid: "wrong" },
    { ...canonical, uuid: undefined },
    { ...canonical, name: "fullrename" },
    { ...canonical, name: undefined },
    { ...canonical, command: "/tmp/FantasticalMCP" },
    { ...canonical, type: undefined },
    { ...canonical, type: "SSE" },
  ])(
    "returns an empty catalog for noncanonical protected identities",
    async (server) => {
      const { client, original } = guarded(server);
      await expect(
        (client as any).request({ method: "tools/list", params: {} }),
      ).resolves.toEqual({ tools: [] });
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("leaves unrelated client.request unchanged by reference", async () => {
    const client = new Client(
      { name: "test", version: "1" },
      { capabilities: {} },
    );
    const original = client.request;
    installFantasticalRequestGuard(client, {
      ...canonical,
      uuid: "other",
      name: "calendar",
      command: "calendar",
    });
    expect(client.request).toBe(original);
  });

  it("filters stale reserved catalog entries without database state", () => {
    expect(
      filterFantasticalQualifiedTools([
        { name: "fantastical-suggestions__createCalendarItem" },
        { name: "fantastical-suggestions__findAvailableTimes" },
        { name: "other__createEvent" },
      ]),
    ).toEqual([
      { name: "fantastical-suggestions__findAvailableTimes" },
      { name: "other__createEvent" },
    ]);
  });
});

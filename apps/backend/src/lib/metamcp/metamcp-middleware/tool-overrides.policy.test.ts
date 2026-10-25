import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FANTASTICAL_QUALIFIED_TOOL_NAME,
  FantasticalPolicyError,
} from "../server-tool-policy";

const mocked = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../../../db/index", () => ({ db: { select: mocked.select } }));
vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  clearOverrideCache,
  createToolOverridesCallToolMiddleware,
  createToolOverridesListToolsMiddleware,
  mapOverrideNameToOriginal,
} from "./tool-overrides.functional";

const context = { namespaceUuid: "policy-test", sessionId: "test" };
function rows(value: Record<string, string>[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockResolvedValue(value),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  mocked.select.mockReturnValue(chain);
}
beforeEach(() => {
  clearOverrideCache();
  mocked.select.mockReset();
  rows([]);
});

describe("Fantastical real namespace override boundary", () => {
  it("blocks a forbidden native name before database lookup or downstream dispatch", async () => {
    const downstream = vi.fn();
    const handler = createToolOverridesCallToolMiddleware()(downstream);
    await expect(
      handler(
        {
          method: "tools/call",
          params: {
            name: "fantastical__deleteCalendarItem",
            arguments: {},
          },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    expect(mocked.select).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });
  it("never reverse-translates the canonical tool, including when DB is unavailable", async () => {
    mocked.select.mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    await expect(
      mapOverrideNameToOriginal(
        FANTASTICAL_QUALIFIED_TOOL_NAME,
        context.namespaceUuid,
      ),
    ).resolves.toBe(FANTASTICAL_QUALIFIED_TOOL_NAME);
    expect(mocked.select).not.toHaveBeenCalled();
  });
  it("rejects cross-provider alias targets on both database and warm-cache paths", async () => {
    rows([
      {
        serverName: "fantastical",
        originalName: "findAvailableTimes",
      },
    ]);
    await expect(
      mapOverrideNameToOriginal("other__alias", context.namespaceUuid),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    mocked.select.mockClear();
    await expect(
      mapOverrideNameToOriginal("other__alias", context.namespaceUuid),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
    expect(mocked.select).not.toHaveBeenCalled();
  });
  it("retains unrelated provider alias behavior", async () => {
    rows([{ serverName: "other", originalName: "createEvent" }]);
    await expect(
      mapOverrideNameToOriginal("other__alias", context.namespaceUuid),
    ).resolves.toBe("other__createEvent");
  });
  it("cannot rename protected discovery and removes stale forbidden names even with failed DB", async () => {
    mocked.select.mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    const safe = {
      name: FANTASTICAL_QUALIFIED_TOOL_NAME,
      description: "Suggestions only",
      inputSchema: { type: "object" as const },
    };
    const handler = createToolOverridesListToolsMiddleware()(async () => ({
      tools: [safe, { ...safe, name: "fantastical__futureWrite" }],
    }));
    const result = await handler({ method: "tools/list" }, context);
    expect(result.tools).toEqual([safe]);
    expect(mocked.select).not.toHaveBeenCalled();
  });
});

describe("reverse name cache", () => {
  it("keeps one alias on two servers apart on the call path", async () => {
    rows([{ serverName: "zoom", originalName: "zoom_get_user" }]);
    await expect(
      mapOverrideNameToOriginal("zoom__get_user", context.namespaceUuid),
    ).resolves.toBe("zoom__zoom_get_user");
    rows([]);
    await expect(
      mapOverrideNameToOriginal("linear__get_user", context.namespaceUuid),
    ).resolves.toBe("linear__get_user");
  });
  it("keeps one alias on two servers apart after tools/list", async () => {
    rows([
      {
        uuid: "server",
        overrideName: "authenticate",
        overrideDescription: "",
        overrideAnnotations: "",
      },
    ]);
    const tool = { inputSchema: { type: "object" as const } };
    const handler = createToolOverridesListToolsMiddleware()(async () => ({
      tools: [
        { ...tool, name: "qbo-bl__qbo_authenticate" },
        { ...tool, name: "qbo-home__qbo_authenticate" },
      ],
    }));
    const result = await handler({ method: "tools/list" }, context);
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "qbo-bl__authenticate",
      "qbo-home__authenticate",
    ]);
    mocked.select.mockClear();
    await expect(
      mapOverrideNameToOriginal("qbo-bl__authenticate", context.namespaceUuid),
    ).resolves.toBe("qbo-bl__qbo_authenticate");
    await expect(
      mapOverrideNameToOriginal(
        "qbo-home__authenticate",
        context.namespaceUuid,
      ),
    ).resolves.toBe("qbo-home__qbo_authenticate");
    expect(mocked.select).not.toHaveBeenCalled();
  });
});

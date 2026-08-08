import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./config.service", () => ({
  configService: {
    getSessionLifetime: vi.fn().mockResolvedValue(null),
  },
}));

import { SessionLifetimeManagerImpl } from "./session-lifetime-manager";

describe("SessionLifetimeManagerImpl idle reaping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("touchSession refreshes the timestamp for a known session", () => {
    const manager = new SessionLifetimeManagerImpl<string>("test");
    manager.addSession("s1", "transport");

    vi.advanceTimersByTime(10 * 60 * 1000);
    manager.touchSession("s1");

    expect(manager.getSessionAge("s1")).toBe(0);
  });

  it("touchSession ignores unknown sessions", () => {
    const manager = new SessionLifetimeManagerImpl<string>("test");
    manager.touchSession("ghost");

    expect(manager.getSessionAge("ghost")).toBeUndefined();
    expect(manager.getSessionCount()).toBe(0);
  });

  it("cleanupIdleSessions suspends only sessions past the idle threshold", async () => {
    const manager = new SessionLifetimeManagerImpl<string>("test");
    const idleMs = 30 * 60 * 1000;

    manager.addSession("old", "t-old");
    vi.advanceTimersByTime(idleMs + 1);
    manager.addSession("fresh", "t-fresh");

    const suspended: string[] = [];
    await manager.cleanupIdleSessions(idleMs, async (sessionId) => {
      suspended.push(sessionId);
      manager.removeSession(sessionId);
    });

    expect(suspended).toEqual(["old"]);
    expect(manager.getSession("fresh")).toBe("t-fresh");
    expect(manager.getSession("old")).toBeUndefined();
  });

  it("cleanupIdleSessions skips sessions kept alive by touchSession", async () => {
    const manager = new SessionLifetimeManagerImpl<string>("test");
    const idleMs = 30 * 60 * 1000;

    manager.addSession("busy", "t-busy");
    vi.advanceTimersByTime(idleMs - 1000);
    manager.touchSession("busy");
    vi.advanceTimersByTime(idleMs - 1000);

    const suspended: string[] = [];
    await manager.cleanupIdleSessions(idleMs, async (sessionId) => {
      suspended.push(sessionId);
    });

    expect(suspended).toEqual([]);
  });

  it("cleanupIdleSessions isolates a throwing callback from other sessions", async () => {
    const manager = new SessionLifetimeManagerImpl<string>("test");
    const idleMs = 60 * 1000;

    manager.addSession("a", "t-a");
    manager.addSession("b", "t-b");
    vi.advanceTimersByTime(idleMs + 1);

    const suspended: string[] = [];
    await manager.cleanupIdleSessions(idleMs, async (sessionId) => {
      if (sessionId === "a") {
        throw new Error("close failed");
      }
      suspended.push(sessionId);
    });

    expect(suspended).toEqual(["b"]);
  });
});

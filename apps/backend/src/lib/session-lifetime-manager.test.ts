/**
 * Unit tests for the session-binding mechanism. A public session is keyed in
 * memory by `Mcp-Session-Id` alone; the binding records the endpoint it was
 * created against AND the credential that created it, so a lookup can reject
 * an id presented on a DIFFERENT endpoint (the original cross-endpoint replay
 * hole, PR #84 review round) or under a DIFFERENT credential on the same
 * endpoint.
 *
 * `bindingMatches` is the endpoint-only predicate the persisted-row guards
 * use; `boundSessionMatches` is the endpoint + identity predicate every
 * in-memory lookup funnels through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// config.service reaches @/db transitively; the binding tests never call the
// TTL path, but the import graph still resolves it.
vi.mock("@/db", () => ({ db: {}, pool: { on: vi.fn() } }));

import type { SessionIdentity } from "./metamcp/session-auth";
import {
  bindingMatches,
  boundSessionMatches,
  classifyBindingDenial,
  SessionLifetimeManagerImpl,
} from "./session-lifetime-manager";

const KEY_A: SessionIdentity = { method: "api_key", credentialId: "key-A" };
const KEY_B: SessionIdentity = { method: "api_key", credentialId: "key-B" };

describe("bindingMatches — the endpoint-only predicate", () => {
  const target = { namespaceUuid: "ns-A", endpointName: "ep-A" };

  it("matches only when BOTH namespace uuid and endpoint name agree", () => {
    expect(bindingMatches({ ...target }, target)).toBe(true);
  });

  it("rejects a namespace mismatch", () => {
    expect(
      bindingMatches({ namespaceUuid: "ns-B", endpointName: "ep-A" }, target),
    ).toBe(false);
  });

  it("rejects an endpoint-name mismatch (same namespace)", () => {
    expect(
      bindingMatches({ namespaceUuid: "ns-A", endpointName: "ep-B" }, target),
    ).toBe(false);
  });

  it("treats a missing binding as a non-match (session with no recorded binding is never served)", () => {
    expect(bindingMatches(undefined, target)).toBe(false);
  });
});

describe("boundSessionMatches — endpoint AND creating credential", () => {
  const target = {
    namespaceUuid: "ns-A",
    endpointName: "ep-A",
    identity: KEY_A,
  };

  it("matches when the endpoint and the identity both agree", () => {
    expect(boundSessionMatches({ ...target }, target)).toBe(true);
  });

  it("rejects the SAME endpoint under a different credential", () => {
    expect(boundSessionMatches({ ...target, identity: KEY_B }, target)).toBe(
      false,
    );
  });

  it("still rejects a cross-endpoint presentation by the SAME credential", () => {
    expect(
      boundSessionMatches({ ...target, endpointName: "ep-B" }, target),
    ).toBe(false);
  });

  it("rejects a missing binding entirely", () => {
    expect(boundSessionMatches(undefined, target)).toBe(false);
  });

  it("still shares a session between anonymous callers on an endpoint published without auth", () => {
    // ALLOW_UNAUTHENTICATED_ENDPOINTS puts every caller on the same identity
    // because there is no credential to tell them apart. Refusing here would
    // break that escape hatch outright rather than narrowing it.
    const anon = {
      namespaceUuid: "ns-A",
      endpointName: "ep-A",
      identity: { method: "anonymous" as const, credentialId: null },
    };
    expect(boundSessionMatches({ ...anon }, anon)).toBe(true);
    // It is still a distinct identity from any authenticated one.
    expect(boundSessionMatches({ ...anon }, target)).toBe(false);
    expect(boundSessionMatches({ ...target }, anon)).toBe(false);
  });
});

describe("classifyBindingDenial — which half of the binding failed", () => {
  const target = {
    namespaceUuid: "ns-A",
    endpointName: "ep-A",
    identity: KEY_A,
  };

  it("names a cross-endpoint replay as an ENDPOINT mismatch, not a credential one", () => {
    // The defect this classifier closes: a single hardcoded reason wrote
    // `session_credential_mismatch` for a same-credential, wrong-endpoint
    // replay — asserting an event that did not happen, in an append-only
    // table, in the exact field an operator queries to tell them apart.
    expect(
      classifyBindingDenial({ ...target, endpointName: "ep-B" }, target),
    ).toBe("session_endpoint_mismatch");
    expect(
      classifyBindingDenial({ ...target, namespaceUuid: "ns-B" }, target),
    ).toBe("session_endpoint_mismatch");
  });

  it("names a same-endpoint foreign credential as a CREDENTIAL mismatch", () => {
    expect(classifyBindingDenial({ ...target, identity: KEY_B }, target)).toBe(
      "session_credential_mismatch",
    );
  });

  it("names an anonymous caller on an authenticated session as a credential mismatch", () => {
    const anon = { method: "anonymous" as const, credentialId: null };
    expect(classifyBindingDenial({ ...target, identity: anon }, target)).toBe(
      "session_credential_mismatch",
    );
  });

  it("gives a resident session with NO binding its own reason", () => {
    expect(classifyBindingDenial(undefined, target)).toBe(
      "session_binding_absent",
    );
  });

  it("classifies exactly the cases boundSessionMatches rejects, in the same order", () => {
    // The classifier and the predicate must not drift: every input the
    // predicate refuses gets a reason, and the endpoint half is decided
    // first in both.
    const refused = [
      undefined,
      { ...target, endpointName: "ep-B" },
      { ...target, identity: KEY_B },
      // Both halves wrong — the endpoint half is reported, matching the
      // order boundSessionMatches evaluates them in.
      { ...target, endpointName: "ep-B", identity: KEY_B },
    ];
    for (const binding of refused) {
      expect(boundSessionMatches(binding, target)).toBe(false);
      expect(classifyBindingDenial(binding, target)).toBeTruthy();
    }
    expect(
      classifyBindingDenial(
        { ...target, endpointName: "ep-B", identity: KEY_B },
        target,
      ),
    ).toBe("session_endpoint_mismatch");
  });
});

describe("SessionLifetimeManagerImpl — binding storage", () => {
  it("stores and returns a session's binding, and clears it on removeSession", () => {
    const mgr = new SessionLifetimeManagerImpl<{ id: string }>("test");
    const binding = {
      namespaceUuid: "ns-A",
      endpointName: "ep-A",
      identity: KEY_A,
    };

    mgr.addSession("s1", { id: "s1" }, binding);
    expect(mgr.getSession("s1")).toEqual({ id: "s1" });
    expect(mgr.getSessionBinding("s1")).toEqual(binding);

    mgr.removeSession("s1");
    expect(mgr.getSession("s1")).toBeUndefined();
    expect(mgr.getSessionBinding("s1")).toBeUndefined();
  });

  it("a session added without a binding has an undefined binding (legacy/defensive path)", () => {
    const mgr = new SessionLifetimeManagerImpl<{ id: string }>("test");
    mgr.addSession("s2", { id: "s2" });
    expect(mgr.getSession("s2")).toBeDefined();
    expect(mgr.getSessionBinding("s2")).toBeUndefined();
  });
});

// Fork tests (0173453): the inactivity reaper Dan's fork carries on top of
// the upstream binding storage suite above.
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

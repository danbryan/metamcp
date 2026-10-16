/**
 * Pins the Fantastical guard to the real pooled-client constructor. The
 * 2026-10-10 security import rewrote client.ts and silently dropped this
 * wiring, which left the request guard installed nowhere.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories/index", () => ({
  mcpServersRepository: {},
}));
vi.mock("../../db/repositories/oauth-sessions.repo", () => ({
  oauthSessionsRepository: {},
}));
vi.mock("../config.service", () => ({
  configService: {},
}));

import { createMetaMcpClient } from "./client";
import {
  FANTASTICAL_COMMAND,
  FANTASTICAL_SERVER_NAME,
  FANTASTICAL_SERVER_UUID,
  FantasticalPolicyError,
} from "./server-tool-policy";

const canonical = {
  uuid: FANTASTICAL_SERVER_UUID,
  name: FANTASTICAL_SERVER_NAME,
  command: FANTASTICAL_COMMAND,
  args: [],
  type: "STDIO",
} as any;

describe("createMetaMcpClient Fantastical wiring", () => {
  it("installs the request guard on the canonical server's client", async () => {
    const { client } = createMetaMcpClient(canonical);
    expect(client).toBeDefined();
    expect(client?.request).not.toBe(Client.prototype.request);
    await expect(
      (client as any).request({
        method: "tools/call",
        params: { name: "deleteCalendarItem", arguments: { id: "x" } },
      }),
    ).rejects.toBeInstanceOf(FantasticalPolicyError);
  });

  it("refuses to construct a noncanonical Fantastical identity", () => {
    expect(() =>
      createMetaMcpClient({ ...canonical, command: "/tmp/FantasticalMCP" }),
    ).toThrow(FantasticalPolicyError);
  });

  it("leaves unrelated servers unguarded", () => {
    const { client } = createMetaMcpClient({
      uuid: "other",
      name: "calendar",
      command: "/usr/bin/true",
      args: [],
      type: "STDIO",
    } as any);
    expect(client?.request).toBe(Client.prototype.request);
  });
});

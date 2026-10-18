import type { ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it } from "vitest";
import { defaultMicroPreferences } from "../contract.js";
import { deriveMicroSlots } from "./roster.js";

function session(key: string, options: Record<string, unknown> = {}): ControlUiSession {
  return {
    key,
    updatedAt: 1,
    ...options,
  } as unknown as ControlUiSession;
}

const normalizeKey = (key: string) => key.toLowerCase();

describe("Codex Micro roster projection", () => {
  it("uses error, approval, input, working, unread, and idle priority", () => {
    const preferences = defaultMicroPreferences();
    preferences.agentSource = "priority";
    const sessions = [
      session("idle", { updatedAt: 600 }),
      session("unread", { updatedAt: 500, unread: true }),
      session("working", { updatedAt: 400, hasActiveRun: true }),
      session("input", { updatedAt: 300 }),
      session("approval", { updatedAt: 200 }),
      session("error", { updatedAt: 100, lastRunError: "failed" }),
    ];

    const slots = deriveMicroSlots(
      {
        sessions,
        selectedKey: "",
        focused: false,
        normalizeKey,
        approvalSessionKeys: new Set(["approval"]),
        questionSessionKeys: new Set(["input"]),
      },
      preferences,
    );

    expect(slots.map(({ sessionKey }) => sessionKey)).toEqual([
      "error",
      "approval",
      "input",
      "working",
      "unread",
      "idle",
    ]);
    expect(slots.map(({ status }) => status)).toEqual([
      "error",
      "awaiting-approval",
      "awaiting-response",
      "working",
      "unread",
      "idle",
    ]);
  });

  it("respects selected focused unread state, pinned order, and custom slots", () => {
    const sessions = [
      session("agent:main:new", { updatedAt: 200, unread: true, pinned: true, pinnedAt: 5 }),
      session("agent:main:old", { updatedAt: 100, pinned: true, pinnedAt: 10 }),
    ];
    const preferences = defaultMicroPreferences();
    preferences.agentSource = "pinned";

    const pinned = deriveMicroSlots(
      {
        sessions,
        selectedKey: "AGENT:MAIN:NEW",
        focused: true,
        normalizeKey,
        approvalSessionKeys: new Set(),
        questionSessionKeys: new Set(),
      },
      preferences,
    );
    expect(pinned[0]).toMatchObject({ sessionKey: "agent:main:old", status: "idle" });
    expect(pinned[1]).toMatchObject({
      sessionKey: "agent:main:new",
      status: "idle",
      selected: true,
    });

    preferences.agentSource = "custom";
    preferences.customSessionKeys[0] = null;
    preferences.customSessionKeys[1] = "missing";
    preferences.customSessionKeys[2] = "agent:main:new";
    preferences.customSessionKeys[4] = "agent:main:old";
    const custom = deriveMicroSlots(
      {
        sessions,
        selectedKey: "",
        focused: false,
        normalizeKey,
        approvalSessionKeys: new Set(),
        questionSessionKeys: new Set(),
      },
      preferences,
    );
    expect(custom.map(({ sessionKey }) => sessionKey)).toEqual([
      null,
      null,
      "agent:main:new",
      null,
      "agent:main:old",
      null,
    ]);
  });
});

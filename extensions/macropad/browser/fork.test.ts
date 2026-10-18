import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import { defaultMicroPreferences } from "../contract.js";
import { MicroActionExecutor } from "./actions.js";

type SessionActivity = {
  hasActiveRun?: boolean;
  gatewayHasActiveRun?: boolean;
};

const activityCases: Array<{
  name: string;
  activity: SessionActivity;
  expectedForkFrom?: "last-completed";
}> = [
  { name: "an idle session", activity: { hasActiveRun: false } },
  {
    name: "a running session",
    activity: { hasActiveRun: true },
    expectedForkFrom: "last-completed",
  },
  {
    name: "gateway activity over a stale idle projection",
    activity: { gatewayHasActiveRun: true, hasActiveRun: false },
    expectedForkFrom: "last-completed",
  },
  {
    name: "gateway inactivity over a stale running projection",
    activity: { gatewayHasActiveRun: false, hasActiveRun: true },
  },
];

function createForkHarness(activity: SessionActivity) {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const opened: Array<Record<string, unknown>> = [];
  const source = {
    key: "agent:main:first",
    agentId: "main",
    displayName: "First",
    ...activity,
  } as unknown as ControlUiSession;
  const other = {
    key: "agent:main:second",
    agentId: "main",
    displayName: "Second",
  } as unknown as ControlUiSession;
  const host = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "sessions.create") {
        return { ok: true, key: "agent:main:forked" };
      }
      throw new Error(`Unexpected Gateway request: ${method}`);
    }),
    sessions: {
      rows: [source, other],
      selectedKey: other.key,
      normalizeKey: (key: string) => key.toLowerCase(),
      open: (target: Record<string, unknown>) => opened.push(target),
    },
  } as unknown as ControlUiHost;
  const executor = new MicroActionExecutor({
    host,
    sessions: () => [source, other],
    preferences: defaultMicroPreferences,
    composer: () => null,
    openRoute: vi.fn(),
    assertCurrent: vi.fn(),
    assignCustomSlotSession: async () => ({ status: "assigned" }),
    native: {
      toggleMicrophone: () => "",
      startPushToTalk: () => "",
      stopPushToTalk: () => "",
      sendFocusedKey: () => "",
      moveHistory: () => "",
      toggleSidebar: () => "",
      focusWindow: async () => true,
    },
  });
  return { executor, requests, opened };
}

describe("Codex Micro conversation fork", () => {
  it.each(activityCases)(
    "forks the event-captured conversation with full transcript semantics for $name",
    async ({ activity, expectedForkFrom }) => {
      const { executor, requests, opened } = createForkHarness(activity);

      const message = await executor.execute(
        {
          sequence: 1,
          action: "fork",
          sessionKey: "agent:main:first",
          source: "ACT09",
        },
        4,
      );

      expect(requests).toEqual([
        {
          method: "sessions.create",
          params: {
            parentSessionKey: "agent:main:first",
            agentId: "main",
            fork: true,
            ...(expectedForkFrom ? { forkFrom: expectedForkFrom } : {}),
          },
        },
      ]);
      expect(opened).toEqual([{ sessionKey: "agent:main:forked", agentId: "main" }]);
      expect(message).toContain("Forked the captured conversation");
    },
  );
});

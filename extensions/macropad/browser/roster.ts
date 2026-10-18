import type { ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import type { MicroPreferences, MicroSlot, SlotStatus } from "../contract.js";

export type RosterState = {
  sessions: readonly ControlUiSession[];
  selectedKey: string;
  focused: boolean;
  normalizeKey: (key: string) => string;
  approvalSessionKeys: ReadonlySet<string>;
  questionSessionKeys: ReadonlySet<string>;
};

const statusRank: Record<SlotStatus, number> = {
  error: 0,
  "awaiting-approval": 1,
  "awaiting-response": 2,
  working: 3,
  unread: 4,
  idle: 5,
  off: 6,
};

function updatedAt(session: ControlUiSession): number {
  return session.updatedAt ?? session.lastActivityAt ?? 0;
}

function sessionStatus(session: ControlUiSession, state: RosterState): SlotStatus {
  const key = state.normalizeKey(session.key);
  if (session.lastRunError || session.status === "failed") {
    return "error";
  }
  if (state.approvalSessionKeys.has(key)) {
    return "awaiting-approval";
  }
  if (state.questionSessionKeys.has(key)) {
    return "awaiting-response";
  }
  if (
    session.hasActiveRun === true ||
    session.status === "queued" ||
    session.status === "running"
  ) {
    return "working";
  }
  if (session.unread && !(state.focused && state.normalizeKey(state.selectedKey) === key)) {
    return "unread";
  }
  return "idle";
}

export function deriveMicroSlots(state: RosterState, preferences: MicroPreferences): MicroSlot[] {
  const normalizedSessions = new Map(
    state.sessions.map((session) => [state.normalizeKey(session.key), session] as const),
  );
  const statusBySession = new Map(
    state.sessions.map(
      (session) => [state.normalizeKey(session.key), sessionStatus(session, state)] as const,
    ),
  );
  let chosen: Array<ControlUiSession | null>;
  switch (preferences.agentSource) {
    case "pinned":
      chosen = state.sessions
        .filter((session) => session.pinned)
        .toSorted((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || updatedAt(b) - updatedAt(a));
      break;
    case "priority":
      chosen = state.sessions.toSorted(
        (a, b) =>
          statusRank[sessionStatus(a, state)] - statusRank[sessionStatus(b, state)] ||
          updatedAt(b) - updatedAt(a),
      );
      break;
    case "custom":
      chosen = preferences.customSessionKeys.map((key) =>
        key ? (normalizedSessions.get(state.normalizeKey(key)) ?? null) : null,
      );
      break;
    default:
      chosen = state.sessions.toSorted((a, b) => updatedAt(b) - updatedAt(a));
      break;
  }

  const selectedKey = state.normalizeKey(state.selectedKey);
  const slots: MicroSlot[] = Array.from({ length: 6 }, (_, id) => {
    const session = chosen[id] ?? null;
    if (!session) {
      return { id, sessionKey: null, title: null, status: "off", selected: false };
    }
    const key = state.normalizeKey(session.key);
    return {
      id,
      sessionKey: session.key,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      status: statusBySession.get(key) ?? "idle",
      selected: key === selectedKey,
    };
  });
  return slots;
}

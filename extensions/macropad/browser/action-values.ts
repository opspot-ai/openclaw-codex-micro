import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";

export function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: The object and non-array checks confine this projection to read-only field access.
  return value as Record<string, unknown>;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function sameKey(host: ControlUiHost, left: string, right: string): boolean {
  return host.sessions.normalizeKey(left) === host.sessions.normalizeKey(right);
}

export function getAgentId(
  sessionKey: string,
  sessions: readonly ControlUiSession[],
): string | undefined {
  const row = sessions.find((session) => session.key === sessionKey);
  if (row?.agentId) {
    return row.agentId;
  }
  return /^agent:([^:]+):/u.exec(sessionKey)?.[1];
}

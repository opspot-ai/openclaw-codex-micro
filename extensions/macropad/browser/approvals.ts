import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

type ApprovalKind = "exec" | "plugin" | "system-agent";

export type PendingApproval = {
  id: string;
  kind: ApprovalKind;
  sourceSessionKey: string;
  expiresAtMs: number;
};

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: Approval fields are read only after confirming the payload is a non-array object.
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function approvalSource(value: unknown): string | null {
  const item = record(value);
  if (!item) {
    return null;
  }
  const direct = text(item.sourceSessionKey);
  if (direct) {
    return direct;
  }
  const request = record(item.request);
  return text(request?.sessionKey) ?? text(request?.sourceSessionKey);
}

export function parseApprovalList(value: unknown, kind: ApprovalKind): PendingApproval[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((raw) => {
    const item = record(raw);
    const id = text(item?.id);
    const sourceSessionKey = approvalSource(raw);
    const expiresAtMs = item?.expiresAtMs;
    if (
      !item ||
      !id ||
      !sourceSessionKey ||
      typeof expiresAtMs !== "number" ||
      expiresAtMs <= Date.now() ||
      (item.status !== undefined && item.status !== "pending")
    ) {
      return [];
    }
    return [{ id, kind, sourceSessionKey, expiresAtMs }];
  });
}

export function questionSessionKeys(value: unknown): Set<string> {
  const result = record(value);
  const questions = result?.questions;
  if (!Array.isArray(questions)) {
    return new Set();
  }
  return new Set(
    questions.flatMap((question) => {
      const item = record(question);
      const key = item?.status === "pending" ? text(item.sessionKey) : null;
      return key ? [key] : [];
    }),
  );
}

export async function resolveCapturedApproval(
  host: ControlUiHost,
  sessionKey: string | null,
  decision: "allow-once" | "deny",
  generation: number,
  assertGrant: (generation: number) => void,
): Promise<string> {
  assertGrant(generation);
  if (!sessionKey) {
    throw new Error("No conversation was captured for this approval action.");
  }
  const endpoints: Array<[ApprovalKind, string]> = [
    ["exec", "exec.approval.list"],
    ["plugin", "plugin.approval.list"],
    ["system-agent", "openclaw.approval.list"],
  ];
  const refreshed = await Promise.allSettled(
    endpoints.map(async ([kind, method]) => parseApprovalList(await host.request(method), kind)),
  );
  assertGrant(generation);
  if (refreshed.some((result) => result.status === "rejected")) {
    throw new Error(
      "Could not verify every pending approval queue; open the exact request in OpenClaw and try again.",
    );
  }
  const matching = refreshed.flatMap((result) =>
    result.status === "fulfilled"
      ? result.value.filter(
          (approval) =>
            host.sessions.normalizeKey(approval.sourceSessionKey) ===
            host.sessions.normalizeKey(sessionKey),
        )
      : [],
  );
  if (matching.length !== 1) {
    if (matching.length > 1) {
      throw new Error(
        "Several pending approvals belong to this conversation; resolve the exact request in OpenClaw.",
      );
    }
    throw new Error("No fresh pending approval matches the captured conversation.");
  }
  const approval = matching[0]!;
  if (approval.expiresAtMs <= Date.now()) {
    throw new Error("The matching approval expired before it could be resolved.");
  }
  assertGrant(generation);
  let response: unknown;
  if (approval.kind === "system-agent") {
    response = await host.request("approval.resolve", {
      id: approval.id,
      kind: "system-agent",
      decision,
    });
  } else {
    response = await host.request(
      approval.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve",
      { id: approval.id, decision },
    );
  }
  assertGrant(generation);
  const result = record(response);
  if (approval.kind === "system-agent") {
    if (result?.applied !== true) {
      throw new Error(
        "OpenClaw did not apply a new decision to the matching approval; it may already be resolved.",
      );
    }
    if ("approval" in result) {
      const resolvedApproval = record(result.approval);
      if (!resolvedApproval || resolvedApproval.decision !== decision) {
        throw new Error("OpenClaw returned a different decision for the matching approval.");
      }
    }
  } else if (result?.ok !== true) {
    throw new Error("OpenClaw did not confirm the matching approval decision.");
  }
  return decision === "deny"
    ? "Declined the matching pending approval."
    : "Approved the matching request once.";
}

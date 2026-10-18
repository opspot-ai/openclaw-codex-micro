import type { ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import type { MicroBinding, MicroPreferences } from "../contract.js";
import type { FocusHost, MicroActionCapability, MicroActionComposer } from "./action-contract.js";
import { getAgentId, record, sameKey, text } from "./action-values.js";
import { resolveCapturedApproval } from "./approvals.js";
import { resolveAgentSlot, type MicroGesture } from "./gestures.js";
import { insertNativeSkillMention } from "./skill-binding.js";

type CustomSlotAssignment =
  | { status: "assigned" }
  | { status: "changed" }
  | { status: "failed"; message: string };

export type MicroActionDependencies = {
  host: FocusHost;
  sessions: () => readonly ControlUiSession[];
  preferences: () => MicroPreferences;
  composer: () => MicroActionComposer | null;
  openRoute: (id: string) => void;
  assertCurrent: (generation: number, capability?: MicroActionCapability) => void;
  assignCustomSlotSession: (
    slot: number,
    sessionKey: string,
    generation: number,
  ) => Promise<CustomSlotAssignment>;
  native: {
    toggleMicrophone: (
      sessionKey: string | null,
      forceDictation: boolean,
      generation: number,
    ) => string;
    startPushToTalk: (sessionKey: string | null, generation: number) => string;
    stopPushToTalk: (sessionKey: string | null, generation: number) => string;
    sendFocusedKey: (key: "ArrowUp" | "ArrowDown" | "Enter", generation: number) => string;
    moveHistory: (direction: "back" | "forward", generation: number) => string;
    toggleSidebar: (generation: number) => string;
    focusWindow: (generation: number) => Promise<boolean>;
  };
};

function isFastEnabled(session: ControlUiSession): boolean {
  const raw = record(session) ?? {};
  const mode = raw.fastMode;
  if (mode === true || mode === "ultrafast" || mode === "auto") {
    return true;
  }
  if (mode === false) {
    return false;
  }
  const effective = raw.effectiveFastMode;
  return effective === true || effective === "ultrafast" || effective === "auto";
}

function thinkingLevels(session: ControlUiSession): string[] {
  const levels = record(session)?.thinkingLevels;
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels.flatMap((level) => {
    const id = text(record(level)?.id);
    return id ? [id] : [];
  });
}

export class MicroActionExecutor {
  private readonly createdCustomSlots = new Map<number, { sessionKey: string; agentId?: string }>();

  constructor(private readonly dependencies: MicroActionDependencies) {}

  async execute(gesture: MicroGesture, generation: number): Promise<string> {
    const { host, native } = this.dependencies;
    this.dependencies.assertCurrent(generation);
    const action = gesture.action;
    if (action === "agent-open" || action === "agent-focus") {
      if (!gesture.sessionKey) {
        return this.activateEmptyAgentSlot(gesture, generation, action === "agent-focus");
      }
      const session = await this.requireSession(gesture.sessionKey, generation);
      this.dependencies.assertCurrent(generation, "read");
      host.sessions.open({
        sessionKey: session.key,
        ...(session.agentId ? { agentId: session.agentId } : {}),
      });
      if (action === "agent-focus") {
        const focused = await native.focusWindow(generation);
        if (!focused) {
          return "Opened this session in the Control UI. The browser window did not report focus.";
        }
        return "Opened and focused this session in the Control UI.";
      }
      return "Opened this session in the current Control UI.";
    }
    if (action === "settings") {
      this.dependencies.assertCurrent(generation);
      this.dependencies.openRoute("macropad");
      return "Opened Codex Micro settings.";
    }
    if (action === "microphone-start") {
      return native.startPushToTalk(gesture.sessionKey, generation);
    }
    if (action === "microphone-stop") {
      return native.stopPushToTalk(gesture.sessionKey, generation);
    }
    if (action === "microphone-toggle-dictation") {
      return native.toggleMicrophone(gesture.sessionKey, true, generation);
    }
    if (action === "navigate-previous") {
      return native.sendFocusedKey("ArrowUp", generation);
    }
    if (action === "navigate-next") {
      return native.sendFocusedKey("ArrowDown", generation);
    }
    if (action === "reason-decrease") {
      return this.stepReasoning(gesture.sessionKey, -1, generation);
    }
    if (action === "reason-increase") {
      return this.stepReasoning(gesture.sessionKey, 1, generation);
    }
    if (action === "select") {
      const binding = this.bindingFor(gesture.source);
      if (
        !binding ||
        (binding.type === "command" && (binding.value === "enter" || binding.value === "select"))
      ) {
        return native.sendFocusedKey("Enter", generation);
      }
      return this.executeBinding(binding, gesture, generation);
    }
    if (action === "none") {
      return `No action assigned to ${gesture.source}.`;
    }

    const binding = this.bindingFor(gesture.source, action);
    if (!binding) {
      return this.executeCommand(action, gesture, generation);
    }
    return this.executeBinding(binding, gesture, generation);
  }

  private async activateEmptyAgentSlot(
    gesture: MicroGesture,
    generation: number,
    focus: boolean,
  ): Promise<string> {
    const { host, native } = this.dependencies;
    const slot = resolveAgentSlot(gesture.source);
    if (slot === null) {
      throw new Error(`Unknown empty agent key ${gesture.source}.`);
    }
    const preferences = this.dependencies.preferences();
    if (preferences.agentSource !== "custom") {
      return `${gesture.source} is empty in the ${preferences.agentSource} view; no session was created.`;
    }

    const assignedKey = preferences.customSessionKeys[slot];
    if (gesture.agentTap === "double" && assignedKey) {
      const created = this.createdCustomSlots.get(slot);
      if (created?.sessionKey === assignedKey) {
        this.dependencies.assertCurrent(generation, "read");
        host.sessions.open({
          sessionKey: created.sessionKey,
          ...(created.agentId ? { agentId: created.agentId } : {}),
        });
        const focused = await native.focusWindow(generation);
        return focused
          ? `Focused the new session assigned to ${gesture.source}.`
          : `Opened the new session assigned to ${gesture.source}; the Control UI window did not report focus.`;
      }
    }
    if (assignedKey !== null) {
      return `${gesture.source} changed before this press ran; no new session was created.`;
    }
    if (gesture.agentTap === "double") {
      return `${gesture.source} is still empty; the earlier create did not complete, so this press was not retried.`;
    }

    this.dependencies.assertCurrent(generation, "write");
    const agentId =
      host.agents.selectedId ??
      host.agents.defaultId ??
      host.connection.assistantAgentId ??
      undefined;
    let sessionKey: string | null;
    try {
      sessionKey = await host.sessions.create(agentId ? { agentId } : undefined);
    } catch (error) {
      throw new Error(
        `The new-session result is uncertain, so ${gesture.source} was not retried. Check Recent sessions before pressing again. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!sessionKey) {
      throw new Error(
        `OpenClaw did not confirm a new session for ${gesture.source}; this press was not retried.`,
      );
    }

    try {
      this.dependencies.assertCurrent(generation, "write");
    } catch {
      throw new Error(
        `A new session was created, but ${gesture.source} could not be assigned because the Control UI connection changed. The press was not retried; check Recent sessions after reconnecting.`,
      );
    }

    const assignment = await this.dependencies.assignCustomSlotSession(
      slot,
      sessionKey,
      generation,
    );
    try {
      this.dependencies.assertCurrent(generation);
    } catch {
      const latest = this.dependencies.preferences();
      const persisted =
        latest.agentSource === "custom" && latest.customSessionKeys[slot] === sessionKey;
      throw new Error(
        persisted
          ? `A new session was created and assigned to ${gesture.source}, but the Control UI connection changed before it could be opened or confirmed. Check the slot before retrying; the action was not repeated.`
          : `A new session was created, but ${gesture.source} remains unassigned because the Control UI connection changed. Check Recent sessions after reconnecting; the action was not repeated.`,
      );
    }
    if (assignment.status === "assigned") {
      this.createdCustomSlots.set(slot, { sessionKey, ...(agentId ? { agentId } : {}) });
      host.sessions.open({ sessionKey, ...(agentId ? { agentId } : {}) });
      await host.sessions.refresh();
      this.dependencies.assertCurrent(generation);
      if (focus) {
        const focused = await native.focusWindow(generation);
        return focused
          ? `Created and assigned a new session to ${gesture.source}, then focused the Control UI.`
          : `Created and assigned a new session to ${gesture.source}; the Control UI window did not report focus.`;
      }
      return `Created and assigned a new session to ${gesture.source}.`;
    }

    if (assignment.status === "failed") {
      throw new Error(
        `A new session was created but ${gesture.source} could not be assigned: ${assignment.message}`,
      );
    }
    host.sessions.open({ sessionKey, ...(agentId ? { agentId } : {}) });
    await host.sessions.refresh();
    this.dependencies.assertCurrent(generation);
    throw new Error(
      `A new session was created and opened, but ${gesture.source} was left unchanged because its source or assignment changed during creation.`,
    );
  }

  private executeBinding(
    binding: MicroBinding,
    gesture: MicroGesture,
    generation: number,
  ): Promise<string> | string {
    if (binding.type === "none") {
      return `No action assigned to ${gesture.source}.`;
    }
    if (binding.type === "text") {
      return this.insertText(gesture.sessionKey, binding.value, generation);
    }
    if (binding.type === "skill") {
      return insertNativeSkillMention(
        {
          host: this.dependencies.host,
          sessions: this.dependencies.sessions,
          composer: this.dependencies.composer,
          assertCurrent: this.dependencies.assertCurrent,
          requireSession: (sessionKey, current) => this.requireSession(sessionKey, current),
        },
        gesture.sessionKey,
        binding.value,
        generation,
      );
    }
    if (binding.type === "url") {
      return this.openExternalLink(binding.value, generation);
    }
    return this.executeCommand(binding.value, gesture, generation);
  }

  private bindingFor(source: string, action?: string): MicroBinding | undefined {
    const key = source === "radial" ? (action ?? "") : source;
    return this.dependencies.preferences().bindings[key];
  }

  private async executeCommand(
    command: string,
    gesture: MicroGesture,
    generation: number,
  ): Promise<string> {
    const { host, native } = this.dependencies;
    switch (command) {
      case "fast":
        return this.toggleFastMode(gesture.sessionKey, generation);
      case "approve":
        return resolveCapturedApproval(
          host,
          gesture.sessionKey,
          "allow-once",
          generation,
          (current) => this.dependencies.assertCurrent(current, "grant"),
        );
      case "decline":
        return resolveCapturedApproval(host, gesture.sessionKey, "deny", generation, (current) =>
          this.dependencies.assertCurrent(current, "grant"),
        );
      case "fork":
        return this.forkSession(gesture.sessionKey, generation);
      case "microphone":
        return native.toggleMicrophone(gesture.sessionKey, false, generation);
      case "send":
        return this.sendComposer(gesture.sessionKey, generation);
      case "plan":
        return this.togglePlanMode(gesture.sessionKey, generation);
      case "forward":
        return native.moveHistory("forward", generation);
      case "back":
        return native.moveHistory("back", generation);
      case "sidebar":
        return native.toggleSidebar(generation);
      case "new-session":
        return this.newSession(gesture.sessionKey, generation);
      case "stop":
        return this.stopSession(gesture.sessionKey, generation);
      case "settings":
        this.dependencies.assertCurrent(generation);
        this.dependencies.openRoute("settings");
        return "Opened OpenClaw settings.";
      case "files":
        this.dependencies.assertCurrent(generation);
        this.dependencies.openRoute("files");
        return "Opened Files.";
      case "skills":
        this.dependencies.assertCurrent(generation);
        this.dependencies.openRoute("skills");
        return "Opened Skills.";
      case "enter":
      case "select":
        return native.sendFocusedKey("Enter", generation);
      case "none":
        return `No action assigned to ${gesture.source}.`;
      default:
        throw new Error(`Command “${command}” is not available in the current Control UI.`);
    }
  }

  private async requireSession(
    sessionKey: string | null,
    generation: number,
  ): Promise<ControlUiSession> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "read");
    if (!sessionKey) {
      throw new Error("No conversation was captured for this physical input.");
    }
    const sessions = this.dependencies.sessions();
    const session = sessions.find((row) => sameKey(host, row.key, sessionKey));
    if (session) {
      return session;
    }
    const agentId = getAgentId(sessionKey, sessions);
    const result = record(
      await host.request("sessions.describe", {
        key: sessionKey,
        ...(agentId ? { agentId } : {}),
        includeDerivedTitles: true,
      }),
    );
    this.dependencies.assertCurrent(generation, "read");
    const described = record(result?.session);
    if (!described || described.key !== sessionKey) {
      throw new Error(
        "The captured conversation is no longer available in this Control UI connection.",
      );
    }
    // SAFETY: sessions.describe returns the GatewaySessionRow projection; the exact key check above binds this reply to the captured request.
    return described as unknown as ControlUiSession;
  }

  private async toggleFastMode(sessionKey: string | null, generation: number): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const session = await this.requireSession(sessionKey, generation);
    this.dependencies.assertCurrent(generation, "write");
    const enabled = !isFastEnabled(session);
    const params: Record<string, unknown> = {
      key: session.key,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
      fastMode: enabled,
    };
    await host.request("sessions.patch", params);
    this.dependencies.assertCurrent(generation, "write");
    await host.sessions.refresh();
    this.dependencies.assertCurrent(generation, "write");
    return enabled
      ? "Fast mode enabled for the captured conversation."
      : "Fast mode disabled for the captured conversation.";
  }

  private async togglePlanMode(sessionKey: string | null, generation: number): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const session = await this.requireSession(sessionKey, generation);
    this.dependencies.assertCurrent(generation, "write");
    const currentMode = session.planMode === true;
    const requestedMode = !currentMode;
    await host.request("sessions.patch", {
      key: session.key,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
      planMode: requestedMode,
      expectedPlanMode: currentMode,
    });
    this.dependencies.assertCurrent(generation, "write");
    await host.sessions.refresh();
    this.dependencies.assertCurrent(generation, "write");
    const result = record(
      await host.request("sessions.describe", {
        key: session.key,
        ...(session.agentId ? { agentId: session.agentId } : {}),
        includeDerivedTitles: true,
      }),
    );
    this.dependencies.assertCurrent(generation, "read");
    const readback = record(result?.session);
    if (!readback || readback.key !== session.key || typeof readback.planMode !== "boolean") {
      throw new Error(
        "The session patch returned, but its current Plan mode could not be verified from session readback.",
      );
    }
    if (readback.planMode !== requestedMode) {
      throw new Error(
        `The session readback still reports Plan mode ${readback.planMode ? "on" : "off"}; no retry was made.`,
      );
    }
    return `Plan mode ${readback.planMode ? "enabled" : "disabled"} for the captured conversation; verified from session readback.`;
  }

  private async stepReasoning(
    sessionKey: string | null,
    direction: -1 | 1,
    generation: number,
  ): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const session = await this.requireSession(sessionKey, generation);
    this.dependencies.assertCurrent(generation, "write");
    const raw = record(session) ?? {};
    const levels = thinkingLevels(session);
    const current = text(raw.thinkingLevel);
    const fallback = text(raw.thinkingDefault);
    const currentLevel = current && levels.includes(current) ? current : fallback;
    const index = currentLevel ? levels.indexOf(currentLevel) : -1;
    if (levels.length < 2 || index < 0) {
      throw new Error(
        "Reasoning level choices are unavailable for this conversation; open its native reasoning control first.",
      );
    }
    const nextIndex = Math.max(0, Math.min(levels.length - 1, index + direction));
    if (nextIndex === index) {
      return direction < 0
        ? `Already at the lowest reasoning level (${levels[index]}).`
        : `Already at the highest reasoning level (${levels[index]}).`;
    }
    await host.request("sessions.patch", {
      key: session.key,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
      thinkingLevel: levels[nextIndex],
    });
    this.dependencies.assertCurrent(generation, "write");
    await host.sessions.refresh();
    this.dependencies.assertCurrent(generation, "write");
    return `Reasoning set to ${levels[nextIndex]}.`;
  }

  private async forkSession(sessionKey: string | null, generation: number): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const session = await this.requireSession(sessionKey, generation);
    this.dependencies.assertCurrent(generation, "write");
    const gatewayActive = record(session)?.gatewayHasActiveRun;
    const hasActiveRun = typeof gatewayActive === "boolean" ? gatewayActive : session.hasActiveRun;
    const agentId = session.agentId || getAgentId(session.key, this.dependencies.sessions());
    const result = record(
      await host.request("sessions.create", {
        parentSessionKey: session.key,
        ...(agentId ? { agentId } : {}),
        fork: true,
        ...(hasActiveRun ? { forkFrom: "last-completed" } : {}),
      }),
    );
    this.dependencies.assertCurrent(generation, "write");
    const newKey = text(result?.key);
    if (!newKey) {
      throw new Error("OpenClaw did not return the new fork session.");
    }
    host.sessions.open({
      sessionKey: newKey,
      ...(agentId ? { agentId } : {}),
    });
    return hasActiveRun
      ? "Forked the captured conversation through its last completed turn and opened the new session."
      : "Forked the captured conversation and opened the new session.";
  }

  private insertText(sessionKey: string | null, value: string, generation: number): string {
    this.dependencies.assertCurrent(generation, "write");
    if (!sessionKey) {
      throw new Error("No conversation was captured for this text binding.");
    }
    const composer = this.dependencies.composer();
    if (!composer || !sameKey(this.dependencies.host, composer.props.sessionKey, sessionKey)) {
      throw new Error(
        "Open the captured conversation's composer in this Control UI to place the text.",
      );
    }
    if (!composer.props.canSend || composer.props.sending) {
      throw new Error(
        composer.props.disabledReason ?? "The native composer cannot accept text right now.",
      );
    }
    composer.props.setDraft(value);
    return "Placed the configured text in the matching native composer draft.";
  }

  private async openExternalLink(value: string, generation: number): Promise<string> {
    this.dependencies.assertCurrent(generation);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("URL bindings need an absolute HTTP or HTTPS address.");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("URL bindings support only HTTP(S) addresses without embedded credentials.");
    }
    const openExternal = this.dependencies.host.links?.openExternal;
    if (!openExternal) {
      throw new Error("The native Control UI external-link action is unavailable in this host.");
    }
    let admitted: boolean;
    try {
      admitted = await openExternal.call(this.dependencies.host.links, url.toString());
    } catch {
      throw new Error(
        "The external-link outcome is uncertain; it was not retried. Check the browser before pressing again.",
      );
    }
    this.dependencies.assertCurrent(generation);
    if (!admitted) {
      throw new Error("The Control UI declined this external-link request.");
    }
    return "Requested the external link through the native Control UI; page visibility is not verified.";
  }

  private async sendComposer(sessionKey: string | null, generation: number): Promise<string> {
    this.dependencies.assertCurrent(generation, "write");
    if (!sessionKey) {
      throw new Error("No conversation was captured for this send action.");
    }
    const composer = this.dependencies.composer();
    if (!composer || !sameKey(this.dependencies.host, composer.props.sessionKey, sessionKey)) {
      throw new Error("The native composer is showing a different conversation; nothing was sent.");
    }
    if (!composer.props.canSend || composer.props.sending) {
      throw new Error(
        composer.props.disabledReason ?? "The native composer has nothing ready to send.",
      );
    }
    const admitted = await composer.props.send();
    this.dependencies.assertCurrent(generation, "write");
    if (admitted === false) {
      throw new Error("The native composer rejected the send.");
    }
    return "Sent the draft through the matching native composer.";
  }

  private async stopSession(sessionKey: string | null, generation: number): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const session = await this.requireSession(sessionKey, generation);
    this.dependencies.assertCurrent(generation, "write");
    const result = record(
      await host.request("chat.abort", {
        sessionKey: session.key,
        ...(session.agentId ? { agentId: session.agentId } : {}),
      }),
    );
    this.dependencies.assertCurrent(generation, "write");
    if (
      result?.aborted === false ||
      (Array.isArray(result?.runIds) && result.runIds.length === 0)
    ) {
      throw new Error("There was no active response to stop in the captured conversation.");
    }
    return "Stop requested for the captured conversation.";
  }

  private async newSession(sessionKey: string | null, generation: number): Promise<string> {
    const { host } = this.dependencies;
    this.dependencies.assertCurrent(generation, "write");
    const agentId = sessionKey ? getAgentId(sessionKey, this.dependencies.sessions()) : undefined;
    const newKey = await host.sessions.create(agentId ? { agentId } : undefined);
    this.dependencies.assertCurrent(generation, "write");
    if (!newKey) {
      throw new Error("OpenClaw did not create a new session.");
    }
    host.sessions.open({ sessionKey: newKey, ...(agentId ? { agentId } : {}) });
    return "Created and opened a new native session.";
  }
}

import type {
  ControlUiHost,
  ControlUiSession,
  ControlUiSessionListSnapshot,
  ControlUiSurfaceProps,
} from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import {
  type MicroDevice,
  type MicroInput,
  type MicroPreferences,
  type MicroReceipt,
  type MicroSlot,
  emptyMicroSlots,
  macropadContract,
} from "../contract.js";
import { MicroActionExecutor } from "./actions.js";
import { parseApprovalList, questionSessionKeys, type PendingApproval } from "./approvals.js";
import { MicroGameInputRouter, type MicroGameAttachment } from "./game-input.js";
import type { MicroGamesSurface } from "./games.js";
import { MicroGestureDecoder, type MicroGesture } from "./gestures.js";
import { MicroNativeControls } from "./native-controls.js";
import { MicroPreferenceStore } from "./preferences.js";
import { deriveMicroSlots } from "./roster.js";
import type { MicroSettingsSnapshot } from "./settings.js";
import { MicroVoiceController } from "./voice.js";

type ComposerProps = ControlUiSurfaceProps["composer"];
type MacropadFeatureClient = FeatureClient<typeof macropadContract>;
const sessionQuery = {
  limit: 100,
  archived: false,
  configuredAgentsOnly: false,
  includeGlobal: true,
  includeUnknown: false,
  includeDerivedTitles: true,
  includeLastMessage: false,
} as const;

function randomClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `micro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sameKey(host: ControlUiHost, left: string, right: string): boolean {
  return host.sessions.normalizeKey(left) === host.sessions.normalizeKey(right);
}

export class MicroBrowserController {
  readonly clientId = randomClientId();
  readonly feature: MacropadFeatureClient;
  private readonly actions: MicroActionExecutor;
  private readonly preferenceStore: MicroPreferenceStore;
  device: MicroDevice | null = null;
  private slots: MicroSlot[] = emptyMicroSlots();
  private sessions: readonly ControlUiSession[] = [];
  private selectedKey = "";
  private approvalRequests: PendingApproval[] = [];
  private questionSessionKeys = new Set<string>();
  private error: string | null = null;
  private receipt: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private preferencesWatch: (() => void) | null = null;
  private sessionSubscription: { dispose: () => void; refresh: () => Promise<void> } | null = null;
  composer: { props: ComposerProps; container: HTMLElement; token: object } | null = null;
  private composerObserver: MutationObserver | null = null;
  private readonly voice: MicroVoiceController;
  private readonly nativeControls: MicroNativeControls;
  private readonly decoder: MicroGestureDecoder;
  private readonly gameInput: MicroGameInputRouter;
  private syncAgain = false;
  private syncRunning = false;
  disposed = false;
  private connectionGeneration = 0;
  private connectionSignature = "";
  private lastReceiptSequence = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private attentionTimer: ReturnType<typeof setInterval> | null = null;
  private lastAttentionRefresh = 0;
  focused = typeof document !== "undefined" ? document.hasFocus() : false;
  private observedSocketGeneration: number | undefined;
  private observedConnectionId: string | undefined;
  private observedConnected = false;

  constructor(readonly host: ControlUiHost) {
    this.feature = createFeatureClient(macropadContract, host);
    this.preferenceStore = new MicroPreferenceStore({
      connected: () => this.host.connection.connected,
      canWrite: () => this.host.connection.canWrite,
      generation: () => this.connectionGeneration,
      assertWrite: (generation) => this.assertCurrent(generation, "write"),
      save: (preferences) => this.feature.invoke("preferences.set", preferences),
      onChange: () => {
        this.recomputeSlots();
        this.publish();
        this.requestSync();
      },
      onError: (error) => {
        this.error = error === null ? null : this.message(error);
      },
      currentError: () => this.error,
    });
    this.connectionSignature = this.getConnectionSignature();
    this.observedSocketGeneration = host.connection.generation;
    this.observedConnectionId = host.connection.id;
    this.observedConnected = host.connection.connected;
    this.decoder = new MicroGestureDecoder((gesture) => this.enqueueGesture(gesture));
    this.gameInput = new MicroGameInputRouter(() => this.decoder.clear());
    this.nativeControls = new MicroNativeControls(host, (generation) =>
      this.assertCurrent(generation),
    );
    this.voice = new MicroVoiceController({
      host,
      composer: () => this.composer,
      assertWrite: (generation) => this.assertCurrent(generation, "write"),
      onStateChange: () => this.requestSync(),
      onError: (error) => this.setError(error),
    });
    this.actions = new MicroActionExecutor({
      host,
      sessions: () => this.sessions,
      preferences: () => this.preferences,
      composer: () => this.composer,
      openRoute: (id) => this.openRoute(id),
      assertCurrent: (generation, capability) => this.assertCurrent(generation, capability),
      assignCustomSlotSession: (slot, sessionKey, generation) =>
        this.preferenceStore.assignSession(slot, sessionKey, generation),
      native: {
        toggleMicrophone: (sessionKey, forceDictation, generation) =>
          this.voice.toggleMicrophone(sessionKey, forceDictation, generation),
        startPushToTalk: (sessionKey, generation) =>
          this.voice.startPushToTalk(sessionKey, generation),
        stopPushToTalk: (sessionKey, generation) =>
          this.voice.stopPushToTalk(sessionKey, generation),
        sendFocusedKey: (key, generation) => this.nativeControls.sendFocusedKey(key, generation),
        moveHistory: (direction, generation) =>
          this.nativeControls.moveHistory(direction, generation),
        toggleSidebar: (generation) => this.nativeControls.toggleSidebar(generation),
        focusWindow: (generation) => this.nativeControls.focusWindow(generation),
      },
    });
  }

  start(): void {
    this.disposers.push(
      this.feature.on("input", (input) => this.receiveInput(input)),
      this.feature.on("result", (result) => this.receiveResult(result)),
      this.host.subscribe(() => this.handleHostChange()),
      this.host.onEvent("exec.approval.requested", () => void this.refreshAttention(true)),
      this.host.onEvent("exec.approval.resolved", () => void this.refreshAttention(true)),
      this.host.onEvent("plugin.approval.requested", () => void this.refreshAttention(true)),
      this.host.onEvent("plugin.approval.resolved", () => void this.refreshAttention(true)),
      this.host.onEvent("openclaw.approval.requested", () => void this.refreshAttention(true)),
      this.host.onEvent("openclaw.approval.resolved", () => void this.refreshAttention(true)),
      this.host.onEvent("question.requested", () => void this.refreshAttention(true)),
      this.host.onEvent("question.resolved", () => void this.refreshAttention(true)),
    );

    this.disposers.push(
      this.feature.watch(
        "device.get",
        {},
        {
          events: ["device_changed"],
          onChange: (device) => {
            this.gameInput.deviceChanged(Boolean(this.device?.connected), device.connected);
            this.device = device;
            this.publish();
            this.requestSync();
          },
          onError: (error) => this.setError(error),
        },
      ),
    );
    this.watchPreferences();
    this.disposers.push(() => {
      this.preferencesWatch?.();
      this.preferencesWatch = null;
    });

    this.sessionSubscription = this.host.sessions.observe(sessionQuery, (snapshot) => {
      this.handleSessionSnapshot(snapshot);
    });
    void this.host.sessions.refresh().catch((error: unknown) => this.setError(error));
    this.recomputeSlots();
    this.syncTimer = globalThis.setInterval(() => {
      this.updateFocused();
      this.requestSync();
      void this.refreshAttention();
    }, 3_000);
    this.attentionTimer = globalThis.setInterval(() => void this.refreshAttention(), 10_000);
    const onAbort = () => this.dispose();
    this.host.signal.addEventListener("abort", onAbort, { once: true });
    this.disposers.push(
      this.feature.on("slots_changed", () => this.requestSync()),
      () => this.host.signal.removeEventListener("abort", onAbort),
    );
    window.addEventListener("focus", this.onFocusChange);
    window.addEventListener("blur", this.onFocusChange);
    document.addEventListener("visibilitychange", this.onFocusChange);
    this.disposers.push(() => {
      window.removeEventListener("focus", this.onFocusChange);
      window.removeEventListener("blur", this.onFocusChange);
      document.removeEventListener("visibilitychange", this.onFocusChange);
    });
    this.handleHostChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MicroSettingsSnapshot {
    return {
      device: this.device,
      preferences: this.preferences,
      sessions: this.sessions.map((session) => ({
        key: session.key,
        title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      })),
      connected: this.host.connection.connected,
      canWrite: this.host.connection.canWrite,
      preferencesReady: this.preferenceStore.ready,
      planMode: this.currentPlanMode,
      error: this.error,
      receipt: this.receipt,
    };
  }

  get currentPlanMode(): boolean | null {
    const sessionKey = this.composer?.props.sessionKey;
    if (!sessionKey) {
      return null;
    }
    const session = this.sessions.find((row) => sameKey(this.host, row.key, sessionKey));
    if (!session) {
      return null;
    }
    return session.planMode === true;
  }

  get currentSlots(): readonly MicroSlot[] {
    return this.slots;
  }

  private get preferences(): MicroPreferences {
    return this.preferenceStore.preferences;
  }

  get preferencesReady(): boolean {
    return this.preferenceStore.ready;
  }

  async updatePreferences(preferences: MicroPreferences): Promise<boolean> {
    return this.preferenceStore.update(preferences);
  }

  async identify(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      this.assertCurrent(generation, "write");
      await this.feature.invoke("device.identify", {});
      this.assertCurrent(generation, "write");
      this.setReceipt("Device identify signal sent.");
      this.error = null;
    } catch (error) {
      this.setError(error);
    }
  }

  openRoute(id: string): void {
    this.host.navigation.openPage({ id });
  }

  setComposer(props: ComposerProps | null, container: HTMLElement | null, token: object): void {
    if (!props || !container || !this.host.connection.connected) {
      if (this.composer?.token === token) {
        this.gameInput.cancel();
        this.voice.cancelForComposerChange();
        this.composer = null;
        this.composerObserver?.disconnect();
        this.composerObserver = null;
        this.requestSync();
      }
      return;
    }
    if (this.composer?.token === token && this.composer.container === container) {
      const sameSession = sameKey(this.host, this.composer.props.sessionKey, props.sessionKey);
      if (!sameSession || this.composer.props.agentId !== props.agentId) {
        this.gameInput.cancel();
        this.voice.cancelForComposerChange();
      }
      this.composer.props = props;
      this.voice.readState();
      this.requestSync();
      return;
    }
    this.gameInput.cancel();
    this.voice.cancelForComposerChange();
    this.composer = { props, container, token };
    this.composerObserver?.disconnect();
    this.composerObserver = new MutationObserver(() => {
      this.voice.readState();
      this.requestSync();
    });
    this.composerObserver.observe(container, { attributes: true, childList: true, subtree: true });
    this.voice.readState();
    this.requestSync();
  }

  attachGames(surface: MicroGamesSurface, token: object): MicroGameAttachment {
    return this.gameInput.attach(surface, token, () => this.composer?.token ?? null);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.gameInput.dispose();
    this.disposed = true;
    this.decoder.clear();
    this.sessionSubscription?.dispose();
    this.sessionSubscription = null;
    this.composerObserver?.disconnect();
    this.composerObserver = null;
    this.voice.dispose();
    if (this.syncTimer) {
      globalThis.clearInterval(this.syncTimer);
    }
    if (this.attentionTimer) {
      globalThis.clearInterval(this.attentionTimer);
    }
    this.syncTimer = null;
    this.attentionTimer = null;
    for (const dispose of this.disposers.splice(0).toReversed()) {
      dispose();
    }
    if (!this.host.signal.aborted && this.host.connection.connected) {
      void this.feature.invoke("ui.release", { clientId: this.clientId }).catch(() => undefined);
    }
    this.listeners.clear();
  }

  private readonly onFocusChange = (): void => {
    this.updateFocused();
    this.gameInput.focusChanged(this.focused);
    this.recomputeSlots();
    this.publish();
    this.requestSync();
  };

  private handleHostChange(): void {
    const generation = this.connectionGeneration;
    this.refreshConnectionGeneration();
    if (generation !== this.connectionGeneration) {
      this.publish();
      this.requestSync();
    }
    const selected = this.host.sessions.selectedKey;
    if (selected !== this.selectedKey) {
      this.gameInput.cancel();
      this.selectedKey = selected;
      this.recomputeSlots();
      this.publish();
      this.requestSync();
    }
    this.updateFocused();
    if (!this.host.connection.connected) {
      this.publish();
      return;
    }
    void this.refreshAttention();
  }

  private handleSessionSnapshot(snapshot: ControlUiSessionListSnapshot): void {
    if (snapshot.result) {
      this.sessions = snapshot.result.sessions;
    }
    if (snapshot.error && this.host.connection.connected) {
      this.error = snapshot.error;
    }
    this.recomputeSlots();
    this.publish();
    this.requestSync();
  }

  private getConnectionSignature(): string {
    const { connected, generation, id, canRead, canWrite, canGrant, canAdmin, assistantAgentId } =
      this.host.connection;
    return JSON.stringify([
      connected,
      generation ?? null,
      id ?? null,
      canRead,
      canWrite,
      canGrant,
      canAdmin,
      assistantAgentId,
    ]);
  }

  private refreshConnectionGeneration(): void {
    const signature = this.getConnectionSignature();
    if (signature === this.connectionSignature) {
      return;
    }
    const connected = this.host.connection.connected;
    const socketGeneration = this.host.connection.generation;
    const socketId = this.host.connection.id;
    const socketChanged =
      (socketId !== undefined && socketId !== this.observedConnectionId) ||
      (socketGeneration !== undefined &&
        this.observedSocketGeneration !== undefined &&
        socketGeneration !== this.observedSocketGeneration) ||
      (socketId === undefined &&
        socketGeneration === undefined &&
        !this.observedConnected &&
        connected);
    this.connectionSignature = signature;
    this.observedSocketGeneration = socketGeneration;
    this.observedConnectionId = socketId;
    this.observedConnected = connected;
    this.connectionGeneration += 1;
    this.gameInput.cancel();
    this.decoder.clear();
    this.voice.resetForReconnect();
    this.preferenceStore.invalidate();
    if (this.preferencesWatch) {
      this.watchPreferences();
    }
    if (socketChanged) {
      this.gameInput.resetSequence();
      this.lastReceiptSequence = 0;
    }
    this.lastAttentionRefresh = 0;
    if (!this.host.connection.connected || !this.host.connection.canRead) {
      this.approvalRequests = [];
      this.questionSessionKeys.clear();
    }
    this.recomputeSlots();
    this.publish();
    this.requestSync();
  }

  private isCurrent(generation: number): boolean {
    this.refreshConnectionGeneration();
    return (
      !this.disposed && this.host.connection.connected && generation === this.connectionGeneration
    );
  }

  private watchPreferences(): void {
    this.preferencesWatch?.();
    const generation = this.connectionGeneration;
    const signature = this.connectionSignature;
    const current = () =>
      !this.disposed &&
      generation === this.connectionGeneration &&
      signature === this.connectionSignature &&
      signature === this.getConnectionSignature() &&
      this.host.connection.connected;
    this.preferencesWatch = this.feature.watch(
      "preferences.get",
      {},
      {
        events: ["preferences_changed"],
        onChange: (preferences) => {
          if (current()) {
            this.preferenceStore.acceptLoaded(preferences);
          }
        },
        onError: (error) => {
          if (current()) {
            this.setError(error);
          }
        },
      },
    );
  }

  private assertCurrent(generation: number, capability?: "read" | "write" | "grant"): void {
    if (!this.isCurrent(generation)) {
      throw new Error("The Control UI connection changed while this physical action was running.");
    }
    const allowed =
      capability === "read"
        ? this.host.connection.canRead
        : capability === "write"
          ? this.host.connection.canWrite
          : capability === "grant"
            ? this.host.connection.canGrant
            : true;
    if (!allowed) {
      const label = capability === "grant" ? "approval" : capability;
      throw new Error(
        `This Control UI connection does not have ${label} access for the requested action.`,
      );
    }
  }

  private receiveInput(input: MicroInput): void {
    const currentConnectionId = this.host.connection.id;
    if (
      this.disposed ||
      !this.host.connection.connected ||
      !currentConnectionId ||
      input.connectionId !== currentConnectionId ||
      input.clientId !== this.clientId
    ) {
      return;
    }
    this.refreshConnectionGeneration();
    if (this.disposed || !this.gameInput.acceptSequence(input.sequence)) {
      return;
    }
    this.updateFocused();
    this.gameInput.receive(input, this, (ordinaryInput) =>
      this.dispatchOrdinaryInput(ordinaryInput),
    );
  }

  private dispatchOrdinaryInput(input: MicroInput): void {
    if (!this.preferenceStore.ready) {
      this.setError(
        new Error(
          "Saved Codex Micro preferences are still loading; this physical input was not executed. Try again when settings are ready.",
        ),
      );
      return;
    }
    this.decoder.handle(input, this.preferences);
  }

  private enqueueGesture(gesture: MicroGesture): void {
    this.gameInput.enqueueGesture(gesture, this.connectionGeneration, {
      isCurrent: (generation) => this.isCurrent(generation),
      execute: (queuedGesture, generation) => this.actions.execute(queuedGesture, generation),
      sendReceipt: (sequence, action, ok, message, generation) =>
        this.sendReceipt(sequence, action, ok, message, generation),
      onError: (error) => this.setError(error),
    });
  }

  private async sendReceipt(
    sequence: number,
    action: string,
    ok: boolean,
    message: string,
    generation: number,
  ): Promise<void> {
    const bounded = message.slice(0, 512);
    this.receipt = bounded;
    this.error = ok ? null : bounded;
    this.lastReceiptSequence = Math.max(this.lastReceiptSequence, sequence);
    this.publish();
    if (!this.isCurrent(generation)) {
      this.markReceiptUnacknowledged(bounded, "before it could be recorded");
      return;
    }
    try {
      const recorded = await this.feature.invoke("ui.result", {
        clientId: this.clientId,
        sequence,
        action: action.slice(0, 128),
        ok,
        message: bounded,
      });
      if (!this.isCurrent(generation)) {
        this.markReceiptUnacknowledged(bounded, "before it could be acknowledged");
        return;
      }
      if (!recorded.ok) {
        this.receipt =
          "Action result was shown locally, but the device rejected its receipt. The action was not repeated.";
        this.error = this.receipt;
        this.publish();
      }
    } catch (error) {
      const detail = this.isCurrent(generation)
        ? `Action result shown locally, but the device receipt was not recorded: ${this.message(error)}`
        : this.withReceiptNote(
            bounded,
            "before it could be acknowledged after the Control UI connection changed",
          );
      this.setError(new Error(detail));
    }
  }

  private markReceiptUnacknowledged(message: string, reason: string): void {
    const detail = this.withReceiptNote(
      message,
      `${reason} after the Control UI connection changed`,
    );
    this.receipt = detail;
    this.error = detail;
    this.publish();
  }

  private withReceiptNote(message: string, note: string): string {
    const suffix = `Device receipt was not acknowledged ${note}.`;
    const prefix = message.slice(0, Math.max(0, 512 - suffix.length - 1));
    return `${prefix}${prefix ? " " : ""}${suffix}`;
  }

  private receiveResult(result: MicroReceipt): void {
    if (result.sequence < this.lastReceiptSequence) {
      return;
    }
    this.lastReceiptSequence = result.sequence;
    this.receipt = result.message;
    this.error = result.ok ? null : result.message;
    this.publish();
  }

  private async refreshAttention(force = false): Promise<void> {
    if (!this.host.connection.connected || !this.host.connection.canRead) {
      return;
    }
    const generation = this.connectionGeneration;
    const now = Date.now();
    if (!force && now - this.lastAttentionRefresh < 4_000) {
      return;
    }
    this.lastAttentionRefresh = now;
    const requests = await Promise.allSettled([
      this.host.request("exec.approval.list"),
      this.host.request("plugin.approval.list"),
      this.host.request("openclaw.approval.list"),
      this.host.request("question.list"),
    ]);
    if (!this.isCurrent(generation) || !this.host.connection.canRead) {
      return;
    }
    const nextApprovals = requests.slice(0, 3).flatMap((result, index) => {
      if (result.status !== "fulfilled") {
        return [];
      }
      const kinds: PendingApproval["kind"][] = ["exec", "plugin", "system-agent"];
      return parseApprovalList(result.value, kinds[index]!);
    });
    if (
      requests[0]?.status === "fulfilled" ||
      requests[1]?.status === "fulfilled" ||
      requests[2]?.status === "fulfilled"
    ) {
      this.approvalRequests = nextApprovals;
    }
    const questionResult = requests[3];
    if (questionResult?.status === "fulfilled") {
      this.questionSessionKeys = questionSessionKeys(questionResult.value);
    }
    this.recomputeSlots();
    this.publish();
    this.requestSync();
  }

  private updateFocused(): void {
    this.focused = document.hasFocus() && document.visibilityState !== "hidden";
  }

  private recomputeSlots(): void {
    this.slots = deriveMicroSlots(
      {
        sessions: this.sessions,
        selectedKey: this.host.sessions.selectedKey,
        focused: this.focused,
        normalizeKey: this.host.sessions.normalizeKey,
        approvalSessionKeys: new Set(
          this.approvalRequests.map((approval) =>
            this.host.sessions.normalizeKey(approval.sourceSessionKey),
          ),
        ),
        questionSessionKeys: new Set(
          [...this.questionSessionKeys].map((key) => this.host.sessions.normalizeKey(key)),
        ),
      },
      this.preferences,
    );
  }

  private requestSync(): void {
    if (this.disposed || !this.host.connection.connected) {
      return;
    }
    this.syncAgain = true;
    if (this.syncRunning) {
      return;
    }
    this.syncRunning = true;
    void (async () => {
      try {
        while (this.syncAgain && !this.disposed && this.host.connection.connected) {
          const generation = this.connectionGeneration;
          this.syncAgain = false;
          this.updateFocused();
          try {
            await this.feature.invoke("ui.sync", {
              clientId: this.clientId,
              focused: this.focused,
              slots: this.slots,
              voiceState: this.voice.state,
            });
          } catch (error) {
            if (this.isCurrent(generation)) {
              this.setError(error);
            }
            return;
          }
        }
      } finally {
        this.syncRunning = false;
        if (this.syncAgain && !this.disposed && this.host.connection.connected) {
          this.requestSync();
        }
      }
    })();
  }

  private setError(error: unknown): void {
    this.error = this.message(error);
    this.publish();
  }

  private setReceipt(message: string): void {
    this.receipt = message;
    this.publish();
  }

  private message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 512);
  }

  private publish(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

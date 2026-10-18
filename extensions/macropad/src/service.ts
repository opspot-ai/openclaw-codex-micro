import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import type { FeatureEvent, FeatureEventName } from "openclaw/plugin-sdk/feature-contract";
import {
  defaultMicroPreferences,
  emptyMicroSlots,
  macropadContract,
  type MicroDevice,
  type MicroInput,
  type MicroPreferences,
  type MicroReceipt,
  type MicroSlot,
  type MicroSync,
} from "../contract.js";
import {
  createCodexMicroTransport,
  MicroTransportError,
  type DeviceInput,
  type MicroTransportPort,
} from "./codex-micro/transport.js";
import { MicroControllerLease, MICRO_CONTROLLER_TTL_MS } from "./controller-lease.js";
import {
  copyPreferences,
  copySlots,
  DIM_DELAY_MS,
  hardwareFields,
  identifyLighting,
  initialDevice,
  sameValue,
  type MicroVoiceState,
} from "./device-state.js";
import { composeFactoryLighting, lightingFingerprint } from "./lighting.js";

const RECONNECT_INTERVAL_MS = 2_000;
const STATUS_INTERVAL_MS = 10_000;
const IDENTIFY_FLASH_MS = 800;
const SELECTION_FLASH_MS = 4_000;
const MICRO_VOICE_STATES: ReadonlySet<MicroVoiceState> = new Set([
  "idle",
  "recording",
  "processing",
  "completed",
]);

type EventName = FeatureEventName<typeof macropadContract>;
type EventPayloadMap = { [K in EventName]: FeatureEvent<typeof macropadContract, K> };
type SnapshotEventName = Exclude<EventName, "input" | "result">;
type PendingSnapshot = {
  [K in SnapshotEventName]: { event: K; payload: EventPayloadMap[K] };
}[SnapshotEventName];
type MicroServiceLogger = Pick<RuntimeLogger, "warn">;

export type MicroServiceOptions = {
  emit: <K extends EventName>(event: K, payload: EventPayloadMap[K]) => void;
  logger?: MicroServiceLogger;
  loadPreferences: () => Promise<MicroPreferences | undefined>;
  savePreferences: (preferences: MicroPreferences) => Promise<void>;
  createTransport?: () => MicroTransportPort;
  now?: () => number;
};

function normalizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

/**
 * Owns the Micro HID lifecycle and current operator/device projections. The
 * controller lease owns authenticated UI identity and survives blur until
 * release or expiry so hardware controls can still reach the operator.
 * Conversation data is held only in memory for this service run; the host keyed
 * store owns preferences.
 */
export class MicroService {
  readonly #now: () => number;
  readonly #pendingSnapshots = new Map<SnapshotEventName, PendingSnapshot>();
  readonly #controllerLease = new MicroControllerLease();
  #started = false;
  #generation = 0;
  #transport: MicroTransportPort | null = null;
  #unsubscribeInput: (() => void) | null = null;
  #preferences = defaultMicroPreferences();
  #preferenceReadError: string | null = null;
  #deviceError: string | null = null;
  #slots = emptyMicroSlots();
  #voiceState: MicroVoiceState = "idle";
  #device = initialDevice("unknown");
  #selectionIdentity: string | null = null;
  #selectionChangedAt: number | null = null;
  #lastActivityAt = 0;
  #dimmed = false;
  #identifying = false;
  #lastLightingFingerprint: string | null = null;
  #lightingQueue: Promise<void> = Promise.resolve();
  #preferenceQueue: Promise<void> = Promise.resolve();
  #connectionTimer: ReturnType<typeof setTimeout> | null = null;
  #controllerTimer: ReturnType<typeof setTimeout> | null = null;
  #dimTimer: ReturnType<typeof setTimeout> | null = null;
  #selectionTimer: ReturnType<typeof setTimeout> | null = null;
  #identifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: MicroServiceOptions) {
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    const generation = ++this.#generation;
    this.#controllerLease.clear();
    this.#preferences = defaultMicroPreferences();
    this.#preferenceReadError = null;
    this.#deviceError = null;
    this.#slots = emptyMicroSlots();
    this.#voiceState = "idle";
    this.#selectionIdentity = null;
    this.#selectionChangedAt = null;
    this.#dimmed = false;
    this.#identifying = false;
    this.#lastLightingFingerprint = null;
    this.#device = initialDevice("unknown");

    // Finish any save started by the previous lifecycle before reloading the
    // host-owned value. This keeps a late store write from overwriting the
    // preference snapshot for a restarted service.
    await this.#preferenceQueue;
    if (!this.#isCurrent(generation)) {
      return;
    }

    try {
      const loaded = await this.options.loadPreferences();
      if (!this.#isCurrent(generation)) {
        return;
      }
      if (loaded) {
        this.#preferences = copyPreferences(loaded);
      }
    } catch (error) {
      this.#preferenceReadError = normalizedError(error);
      this.#warn(
        `Could not load Codex Micro preferences; physical input is disabled until settings are saved: ${this.#preferenceReadError}`,
      );
    }
    if (!this.#isCurrent(generation)) {
      return;
    }

    this.#emitSnapshot("preferences_changed", this.getPreferences());
    try {
      const transport = this.options.createTransport?.() ?? createCodexMicroTransport();
      this.#transport = transport;
      this.#unsubscribeInput = transport.onInput((event) => this.#handleInput(event));
      const permission = transport.inspectPermission();
      this.#setDevice({ ...initialDevice(permission), inputCount: this.#device.inputCount });
      if (!transport.supported) {
        this.#setDevice({
          ...this.#device,
          error: "Codex Micro hardware support is available on macOS only.",
        });
        return;
      }
    } catch (error) {
      this.#setDevice({
        ...initialDevice("unsupported"),
        error: normalizedError(error),
      });
      return;
    }

    await this.#checkConnection(generation);
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#transport) {
      return;
    }
    this.#started = false;
    this.#generation++;
    this.#clearTimer("connection");
    this.#clearTimer("controller");
    this.#clearTimer("dim");
    this.#clearTimer("selection");
    this.#clearTimer("identify");
    this.#controllerLease.clear();
    this.#identifying = false;
    this.#unsubscribeInput?.();
    this.#unsubscribeInput = null;
    const transport = this.#transport;
    this.#transport = null;
    if (transport) {
      try {
        await transport.dispose();
      } catch (error) {
        this.#warn(`Could not fully close Codex Micro transport: ${normalizedError(error)}`);
      }
    }
    await this.#lightingQueue;
    await this.#preferenceQueue;
    this.#pendingSnapshots.clear();
  }

  getDevice(): MicroDevice {
    return { ...this.#device };
  }

  getSlots(): MicroSlot[] {
    return this.#slots.map((slot) => ({ ...slot }));
  }

  getPreferences(): MicroPreferences {
    return copyPreferences(this.#preferences);
  }

  async setPreferences(preferences: MicroPreferences): Promise<MicroPreferences> {
    if (!this.#started) {
      throw new Error("Codex Micro service is not running.");
    }
    const generation = this.#generation;
    const next = copyPreferences(preferences);
    const operation = this.#preferenceQueue.then(async () => {
      if (!this.#isCurrent(generation)) {
        throw new Error("Codex Micro service stopped before preferences were saved.");
      }
      await this.options.savePreferences(next);
      if (!this.#isCurrent(generation)) {
        throw new Error("Codex Micro service stopped before preferences were applied.");
      }
      const recoveredReadError = this.#preferenceReadError !== null;
      this.#preferenceReadError = null;
      const changed = !sameValue(this.#preferences, next);
      this.#preferences = next;
      if (recoveredReadError) {
        this.#setDevice({ ...this.#device, error: this.#deviceError });
      }
      this.#emitSnapshot("preferences_changed", this.getPreferences());
      if (changed) {
        this.#noteActivity();
        this.#scheduleSelectionTimer(generation);
        await this.#renderLighting(generation);
      }
      return this.getPreferences();
    });
    this.#preferenceQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  syncUi(input: MicroSync, connectionId: string): { ok: boolean } {
    if (!this.#started) {
      return { ok: false };
    }
    if (!MICRO_VOICE_STATES.has(input.voiceState)) {
      return { ok: false };
    }
    const voiceState = input.voiceState;
    const now = this.#now();
    this.#expireControllerIfDue(now);
    if (!this.#controllerLease.synchronize(input, connectionId, now)) {
      return { ok: false };
    }
    this.#scheduleControllerExpiration();
    this.#applyUiSnapshot(input.slots, voiceState, now);
    return { ok: true };
  }

  releaseUi(clientId: string, connectionId: string): { ok: boolean } {
    if (!this.#started || !this.#controllerLease.matches(clientId, connectionId)) {
      return { ok: false };
    }
    this.#clearController();
    return { ok: true };
  }

  recordResult(clientId: string, receipt: MicroReceipt, connectionId: string): { ok: boolean } {
    if (!this.#started) {
      return { ok: false };
    }
    const now = this.#now();
    this.#expireControllerIfDue(now);
    if (!this.#controllerLease.consumeReceipt(clientId, receipt, connectionId, now)) {
      return { ok: false };
    }
    return { ok: this.#emitEphemeral("result", { ...receipt }) };
  }

  async identify(): Promise<{ ok: boolean }> {
    if (!this.#started || !this.#device.connected) {
      return { ok: false };
    }
    const generation = this.#generation;
    this.#identifying = true;
    this.#noteActivity();
    this.#clearTimer("identify");
    this.#identifyTimer = setTimeout(() => {
      this.#identifyTimer = null;
      if (!this.#isCurrent(generation)) {
        return;
      }
      this.#identifying = false;
      void this.#renderLighting(generation);
    }, IDENTIFY_FLASH_MS);
    return { ok: await this.#renderLighting(generation, true) };
  }

  #isCurrent(generation: number): boolean {
    return this.#started && this.#generation === generation;
  }

  async #checkConnection(generation: number): Promise<void> {
    if (!this.#isCurrent(generation) || !this.#transport) {
      return;
    }
    const transport = this.#transport;
    if (this.#device.connected) {
      try {
        const status = await transport.status();
        if (!this.#isCurrent(generation) || transport !== this.#transport) {
          return;
        }
        this.#setDevice({
          ...this.#device,
          firmware: status.version ?? this.#device.firmware,
          battery: status.battery ?? null,
          charging: status.isCharging ?? false,
          inputPermission: transport.inspectPermission(),
          error: null,
        });
        this.#scheduleConnectionCheck(generation, STATUS_INTERVAL_MS);
        if (this.#lastLightingFingerprint === null) {
          await this.#renderLighting(generation, true);
        }
        return;
      } catch (error) {
        if (!this.#isCurrent(generation) || transport !== this.#transport) {
          return;
        }
        const permission = transport.inspectPermission();
        this.#setDevice({
          ...this.#device,
          connected: false,
          inputPermission: permission,
          error: normalizedError(error),
        });
        this.#lastLightingFingerprint = null;
        await transport.disconnect().catch(() => undefined);
      }
    }

    try {
      const info = await transport.connect();
      if (!this.#isCurrent(generation) || transport !== this.#transport) {
        await transport.disconnect();
        return;
      }
      this.#dimmed = false;
      this.#lastActivityAt = this.#now();
      this.#setDevice({
        ...this.#device,
        ...hardwareFields(info),
        connected: true,
        inputPermission: transport.inspectPermission(),
        error: null,
        dimmed: false,
      });
      this.#lastLightingFingerprint = null;
      this.#scheduleDimTimer(generation);
      this.#scheduleSelectionTimer(generation);
      await this.#renderLighting(generation, true);
      if (this.#isCurrent(generation) && transport === this.#transport) {
        this.#scheduleConnectionCheck(generation, STATUS_INTERVAL_MS);
      }
    } catch (error) {
      if (!this.#isCurrent(generation) || transport !== this.#transport) {
        return;
      }
      const failure = error instanceof MicroTransportError ? error : null;
      const info = failure?.info;
      const permission = failure?.permission ?? transport.inspectPermission();
      this.#setDevice({
        ...this.#device,
        ...(info
          ? {
              product: info.product?.slice(0, 128) ?? null,
              transport:
                info.transport === "USB"
                  ? "USB"
                  : info.transport === "Bluetooth Low Energy"
                    ? "BLE"
                    : null,
            }
          : {}),
        connected: false,
        firmware: null,
        battery: null,
        charging: false,
        inputPermission: permission,
        error: normalizedError(error),
        dimmed: false,
      });
      this.#lastLightingFingerprint = null;
      await transport.disconnect().catch(() => undefined);
      if (this.#isCurrent(generation) && transport === this.#transport) {
        this.#scheduleConnectionCheck(generation, RECONNECT_INTERVAL_MS);
      }
    }
  }

  #scheduleConnectionCheck(generation: number, delay: number): void {
    this.#clearTimer("connection");
    this.#connectionTimer = setTimeout(() => {
      this.#connectionTimer = null;
      void this.#checkConnection(generation);
    }, delay);
  }

  #applyUiSnapshot(slots: readonly MicroSlot[], voiceState: MicroVoiceState, now: number): void {
    const nextSlots = copySlots(slots);
    const changed = !sameValue(this.#slots, nextSlots) || this.#voiceState !== voiceState;
    if (!changed) {
      return;
    }

    const selected = nextSlots.find((slot) => slot.selected && slot.sessionKey !== null);
    const identity = selected ? `${selected.id}\u0000${selected.sessionKey}` : null;
    const selectionChanged = identity !== this.#selectionIdentity;
    this.#selectionIdentity = identity;
    if (selectionChanged) {
      this.#selectionChangedAt = identity === null ? null : now;
    }
    this.#slots = nextSlots;
    this.#voiceState = voiceState;
    this.#emitSnapshot("slots_changed", this.getSlots());
    this.#noteActivity();
    this.#scheduleSelectionTimer(this.#generation);
    void this.#renderLighting(this.#generation);
  }

  #handleInput(event: DeviceInput): void {
    if (!this.#started || !this.#device.connected || this.#preferenceReadError !== null) {
      return;
    }
    this.#setDevice({ ...this.#device, inputCount: this.#device.inputCount + 1 });
    const countsAsActivity = event.kind === "key" || event.distance > 0.1;
    if (countsAsActivity) {
      this.#noteActivity();
    }
    void this.#renderLighting(this.#generation);

    this.#expireControllerIfDue(this.#now());
    const controller = this.#controllerLease.current;
    if (!controller) {
      return;
    }
    const sequence = this.#controllerLease.nextSequence();
    const selected = this.#slots.find((slot) => slot.selected && slot.sessionKey !== null);
    const agentSlot = event.kind === "key" ? /^AG0([0-5])$/u.exec(event.key) : null;
    const sessionKey = agentSlot
      ? (this.#slots[Number(agentSlot[1])]?.sessionKey ?? null)
      : (selected?.sessionKey ?? null);
    const common = {
      clientId: controller.clientId,
      connectionId: controller.connectionId,
      sequence,
      sessionKey,
    };
    const input: MicroInput =
      event.kind === "key"
        ? { ...common, kind: "key", key: event.key, act: event.act }
        : { ...common, kind: "radial", angle: event.angle, distance: event.distance };
    const now = this.#now();
    this.#controllerLease.rememberReceipt(
      sequence,
      controller.clientId,
      controller.connectionId,
      now,
    );
    if (!this.#emitEphemeral("input", input)) {
      this.#controllerLease.discardReceipt(sequence);
    }
  }

  #scheduleControllerExpiration(): void {
    this.#clearTimer("controller");
    const controller = this.#controllerLease.current;
    if (!controller) {
      return;
    }
    const deadline = controller.lastHeartbeat + MICRO_CONTROLLER_TTL_MS;
    this.#controllerTimer = setTimeout(
      () => {
        this.#controllerTimer = null;
        if (!this.#controllerLease.isCurrent(controller)) {
          return;
        }
        const remaining = deadline - this.#now();
        if (remaining > 0) {
          this.#scheduleControllerExpiration();
          return;
        }
        this.#expireControllerIfDue(this.#now());
      },
      Math.max(0, deadline - this.#now()),
    );
  }

  #expireControllerIfDue(now: number): void {
    if (this.#controllerLease.expireIfDue(now)) {
      this.#clearController();
    }
  }

  #clearController(): void {
    this.#clearTimer("controller");
    this.#controllerLease.clear();
    const empty = emptyMicroSlots();
    const changed = !sameValue(this.#slots, empty) || this.#voiceState !== "idle";
    this.#slots = empty;
    this.#voiceState = "idle";
    this.#selectionIdentity = null;
    this.#selectionChangedAt = null;
    this.#clearTimer("selection");
    if (changed) {
      this.#emitSnapshot("slots_changed", this.getSlots());
      this.#noteActivity();
      void this.#renderLighting(this.#generation);
    }
  }

  #noteActivity(): void {
    this.#lastActivityAt = this.#now();
    const woke = this.#dimmed;
    this.#dimmed = false;
    if (woke) {
      this.#device = { ...this.#device, dimmed: false };
      this.#emitSnapshot("device_changed", this.getDevice());
    }
    this.#scheduleDimTimer(this.#generation);
  }

  #scheduleDimTimer(generation: number): void {
    this.#clearTimer("dim");
    const delay = DIM_DELAY_MS[this.#preferences.autoDim] ?? null;
    if (delay === null || !this.#started) {
      return;
    }
    const deadline = this.#lastActivityAt + delay;
    this.#dimTimer = setTimeout(
      () => {
        this.#dimTimer = null;
        if (!this.#isCurrent(generation)) {
          return;
        }
        const remaining = deadline - this.#now();
        if (remaining > 0) {
          this.#scheduleDimTimer(generation);
          return;
        }
        this.#dimmed = true;
        this.#device = { ...this.#device, dimmed: true };
        this.#emitSnapshot("device_changed", this.getDevice());
        void this.#renderLighting(generation, true);
      },
      Math.max(0, deadline - this.#now()),
    );
  }

  #scheduleSelectionTimer(generation: number): void {
    this.#clearTimer("selection");
    if (this.#selectionChangedAt === null || !this.#started) {
      return;
    }
    const deadline = this.#selectionChangedAt + SELECTION_FLASH_MS;
    this.#selectionTimer = setTimeout(
      () => {
        this.#selectionTimer = null;
        if (!this.#isCurrent(generation)) {
          return;
        }
        const remaining = deadline - this.#now();
        if (remaining > 0) {
          this.#scheduleSelectionTimer(generation);
          return;
        }
        void this.#renderLighting(generation);
      },
      Math.max(0, deadline - this.#now()),
    );
  }

  async #renderLighting(generation: number, force = false): Promise<boolean> {
    if (!this.#isCurrent(generation) || !this.#transport || !this.#device.connected) {
      return false;
    }
    const transport = this.#transport;
    const operation = this.#lightingQueue.then(async () => {
      if (
        !this.#isCurrent(generation) ||
        transport !== this.#transport ||
        !this.#device.connected
      ) {
        return false;
      }
      const lighting = this.#identifying
        ? identifyLighting(this.#preferences.brightness)
        : composeFactoryLighting({
            slots: this.#slots,
            voiceState: this.#voiceState,
            preferences: this.#preferences,
            now: this.#now(),
            selectionChangedAt: this.#selectionChangedAt,
            dimmed: this.#dimmed,
          });
      const fingerprint = lightingFingerprint(lighting);
      if (!force && fingerprint === this.#lastLightingFingerprint) {
        return true;
      }
      try {
        await transport.setLighting(lighting);
        if (!this.#isCurrent(generation) || transport !== this.#transport) {
          return false;
        }
        this.#lastLightingFingerprint = fingerprint;
        if (this.#device.error !== null) {
          this.#setDevice({ ...this.#device, error: null });
        }
        return true;
      } catch (error) {
        if (this.#isCurrent(generation) && transport === this.#transport) {
          this.#setDevice({ ...this.#device, error: normalizedError(error) });
          this.#lastLightingFingerprint = null;
        }
        return false;
      }
    });
    this.#lightingQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  #setDevice(device: MicroDevice): void {
    if (this.#preferenceReadError === null || device.error !== this.#preferenceReadError) {
      this.#deviceError = device.error;
    }
    const next = { ...device, error: this.#preferenceReadError ?? this.#deviceError };
    if (sameValue(this.#device, next)) {
      return;
    }
    if (this.#device.connected && !next.connected) {
      this.#controllerLease.clearReceipts();
    }
    this.#device = next;
    this.#emitSnapshot("device_changed", this.getDevice());
  }

  #emitSnapshot<K extends SnapshotEventName>(event: K, payload: EventPayloadMap[K]): void {
    this.#flushSnapshots();
    try {
      this.options.emit(event, payload);
    } catch (error) {
      // SAFETY: The generic event K ties payload to event in PendingSnapshot's discriminated union.
      this.#pendingSnapshots.set(event, { event, payload } as PendingSnapshot);
      this.#warn(`Could not emit Codex Micro ${event}: ${normalizedError(error)}`);
    }
  }

  #emitEphemeral<K extends "input" | "result">(event: K, payload: EventPayloadMap[K]): boolean {
    this.#flushSnapshots();
    try {
      this.options.emit(event, payload);
      return true;
    } catch (error) {
      // Inputs and receipts are deliberately dropped on delivery failure; they
      // are never buffered for a reconnect or a later browser controller.
      this.#warn(
        `Could not emit Codex Micro ${event}; the event was discarded: ${normalizedError(error)}`,
      );
      return false;
    }
  }

  #flushSnapshots(): void {
    const pendingSnapshots = [...this.#pendingSnapshots.values()];
    for (const pending of pendingSnapshots) {
      try {
        this.#emitPendingSnapshot(pending);
        this.#pendingSnapshots.delete(pending.event);
      } catch {
        return;
      }
    }
  }

  #emitPendingSnapshot(pending: PendingSnapshot): void {
    switch (pending.event) {
      case "device_changed":
        this.options.emit(pending.event, pending.payload);
        return;
      case "slots_changed":
        this.options.emit(pending.event, pending.payload);
        return;
      case "preferences_changed":
        this.options.emit(pending.event, pending.payload);
    }
  }

  #warn(message: string): void {
    try {
      this.options.logger?.warn(message);
    } catch {
      // A logger failure must not take down the device service.
    }
  }

  #clearTimer(name: "connection" | "controller" | "dim" | "selection" | "identify"): void {
    if (name === "connection" && this.#connectionTimer) {
      clearTimeout(this.#connectionTimer);
    }
    if (name === "controller" && this.#controllerTimer) {
      clearTimeout(this.#controllerTimer);
    }
    if (name === "dim" && this.#dimTimer) {
      clearTimeout(this.#dimTimer);
    }
    if (name === "selection" && this.#selectionTimer) {
      clearTimeout(this.#selectionTimer);
    }
    if (name === "identify" && this.#identifyTimer) {
      clearTimeout(this.#identifyTimer);
    }
    if (name === "connection") {
      this.#connectionTimer = null;
    }
    if (name === "controller") {
      this.#controllerTimer = null;
    }
    if (name === "dim") {
      this.#dimTimer = null;
    }
    if (name === "selection") {
      this.#selectionTimer = null;
    }
    if (name === "identify") {
      this.#identifyTimer = null;
    }
  }
}

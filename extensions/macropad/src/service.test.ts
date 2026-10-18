import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMicroPreferences, emptyMicroSlots, type MicroSlot } from "../contract.js";
import type { InputPermission } from "./codex-micro/hid-darwin.js";
import {
  MicroTransportError,
  type DeviceInput,
  type MicroHardwareInfo,
  type MicroTransportPort,
} from "./codex-micro/transport.js";
import type { FactoryLighting } from "./lighting.js";
import { MicroService, type MicroServiceOptions } from "./service.js";

class FakeTransport implements MicroTransportPort {
  readonly supported = true;
  readonly lighting: FactoryLighting[] = [];
  connectFailures = 0;
  connectCalls = 0;
  disconnectCalls = 0;
  permission: InputPermission = "granted";
  #listener: ((event: DeviceInput) => void) | null = null;
  #connected = false;

  inspectPermission(): InputPermission {
    return this.permission;
  }

  onInput(listener: (event: DeviceInput) => void): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) {
        this.#listener = null;
      }
    };
  }

  async connect(): Promise<MicroHardwareInfo> {
    this.connectCalls++;
    if (this.connectFailures > 0) {
      this.connectFailures--;
      throw new MicroTransportError("Codex Micro was not found.", { permission: this.permission });
    }
    this.#connected = true;
    return {
      product: "Codex Micro",
      firmware: "0.4.1",
      transport: "USB",
      battery: 83,
      charging: false,
    };
  }

  async status() {
    if (!this.#connected) {
      throw new Error("device disconnected");
    }
    return { version: "0.4.1", battery: 83, isCharging: false };
  }

  async setLighting(lighting: FactoryLighting): Promise<void> {
    if (!this.#connected) {
      throw new Error("device disconnected");
    }
    this.lighting.push(structuredClone(lighting));
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.#connected = false;
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    this.#listener = null;
  }

  emit(input: DeviceInput): void {
    this.#listener?.(input);
  }
}

const services: MicroService[] = [];

function createHarness(
  transport = new FakeTransport(),
  emit: MicroServiceOptions["emit"] = () => undefined,
  savePreferences: MicroServiceOptions["savePreferences"] = async () => undefined,
  loadPreferences: MicroServiceOptions["loadPreferences"] = async () => undefined,
  logger?: MicroServiceOptions["logger"],
) {
  const events: Array<{ event: string; payload: unknown }> = [];
  const service = new MicroService({
    logger,
    emit: (event, payload) => {
      events.push({ event, payload });
      emit(event, payload);
    },
    loadPreferences,
    savePreferences,
    createTransport: () => transport,
    now: Date.now,
  });
  services.push(service);
  return { service, transport, events };
}

function focusedSnapshot(clientId: string, slots = emptyMicroSlots(), focused = true) {
  return { clientId, focused, slots, voiceState: "idle" as const };
}

function selectedSlot(id: number, sessionKey: string): MicroSlot {
  return {
    id,
    sessionKey,
    agentId: "codex",
    title: `Thread ${id}`,
    status: "idle",
    selected: true,
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.useRealTimers();
});

describe("MicroService controller and device lifecycle", () => {
  it("routes physical input to its authenticated controller and accepts one matching receipt", async () => {
    const { service, transport, events } = createHarness();
    await service.start();
    const slots = emptyMicroSlots();
    slots[2] = selectedSlot(2, "session-a");

    expect(service.syncUi(focusedSnapshot("client-a", slots), "connection-a")).toEqual({
      ok: true,
    });
    expect(service.syncUi(focusedSnapshot("client-b"), "connection-b")).toEqual({ ok: false });
    transport.emit({ kind: "key", key: "ACT06", act: 1 });

    const inputEvent = events.findLast((event) => event.event === "input");
    expect(inputEvent?.payload).toEqual({
      clientId: "client-a",
      connectionId: "connection-a",
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "session-a",
    });

    const receipt = { sequence: 1, action: "fast", ok: true, message: "Fast mode enabled" };
    expect(service.syncUi(focusedSnapshot("client-a", slots, false), "connection-a").ok).toBe(true);
    expect(service.recordResult("client-a", receipt, "connection-b")).toEqual({ ok: false });
    expect(service.recordResult("client-b", receipt, "connection-a")).toEqual({ ok: false });
    expect(service.recordResult("client-a", { ...receipt, sequence: 2 }, "connection-a")).toEqual({
      ok: false,
    });
    transport.emit({ kind: "key", key: "ACT06", act: 0 });
    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      clientId: "client-a",
      sequence: 2,
    });
    expect(service.recordResult("client-a", receipt, "connection-a")).toEqual({ ok: true });
    expect(service.recordResult("client-a", receipt, "connection-a")).toEqual({ ok: false });
    expect(service.recordResult("client-a", { ...receipt, sequence: 2 }, "connection-a")).toEqual({
      ok: true,
    });
    expect(
      events.filter((event) => event.event === "result").map((event) => event.payload),
    ).toEqual([receipt, { ...receipt, sequence: 2 }]);
  });

  it("captures the indexed agent slot for AG keys independently of the selected slot", async () => {
    const { service, transport, events } = createHarness();
    await service.start();
    const slots = emptyMicroSlots();
    slots[1] = { ...selectedSlot(1, "session-slot-one"), selected: false };
    slots[2] = selectedSlot(2, "session-selected");
    expect(service.syncUi(focusedSnapshot("client-a", slots), "connection-a").ok).toBe(true);

    transport.emit({ kind: "key", key: "AG01", act: 1 });
    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      key: "AG01",
      sessionKey: "session-slot-one",
    });
  });

  it("allows a blurred owner to continue physical input until a focused client takes over", async () => {
    const { service, transport, events } = createHarness();
    await service.start();
    const slots = emptyMicroSlots();
    slots[0] = selectedSlot(0, "session-a");
    expect(service.syncUi(focusedSnapshot("client-a", slots), "connection-a").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT06", act: 1 });

    expect(service.syncUi(focusedSnapshot("client-a", slots, false), "connection-a").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT06", act: 0 });
    expect(
      events.filter((event) => event.event === "input").map((event) => event.payload),
    ).toMatchObject([
      { clientId: "client-a", sequence: 1, sessionKey: "session-a" },
      { clientId: "client-a", sequence: 2, sessionKey: "session-a" },
    ]);
    expect(
      service.recordResult(
        "client-a",
        { sequence: 1, action: "fast", ok: true, message: "ok" },
        "connection-a",
      ),
    ).toEqual({ ok: true });

    expect(service.syncUi(focusedSnapshot("client-b"), "connection-b").ok).toBe(true);
    expect(
      service.recordResult(
        "client-a",
        { sequence: 2, action: "fast", ok: true, message: "ok" },
        "connection-a",
      ),
    ).toEqual({ ok: false });
    expect(service.syncUi(focusedSnapshot("client-a", slots, false), "connection-a").ok).toBe(
      false,
    );
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      clientId: "client-b",
    });
  });

  it("binds focused controller ownership to the authenticated connection, not client ID", async () => {
    const { service, transport, events } = createHarness();
    await service.start();
    const firstSlots = emptyMicroSlots();
    firstSlots[0] = selectedSlot(0, "session-a");

    expect(service.syncUi(focusedSnapshot("shared-client", firstSlots), "connection-a")).toEqual({
      ok: true,
    });
    expect(service.syncUi(focusedSnapshot("shared-client"), "connection-b")).toEqual({
      ok: false,
    });
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      clientId: "shared-client",
      connectionId: "connection-a",
      sessionKey: "session-a",
    });

    expect(
      service.syncUi(focusedSnapshot("shared-client", firstSlots, false), "connection-a"),
    ).toEqual({
      ok: true,
    });
    const secondSlots = emptyMicroSlots();
    secondSlots[0] = selectedSlot(0, "session-b");
    expect(service.syncUi(focusedSnapshot("shared-client", secondSlots), "connection-b")).toEqual({
      ok: true,
    });
    expect(
      service.syncUi(focusedSnapshot("shared-client", firstSlots, false), "connection-a"),
    ).toEqual({
      ok: false,
    });

    transport.emit({ kind: "key", key: "ACT12", act: 1 });
    const inputs = events.filter((event) => event.event === "input");
    expect(inputs.at(-1)?.payload).toMatchObject({
      clientId: "shared-client",
      connectionId: "connection-b",
      sessionKey: "session-b",
    });
    expect(
      service.recordResult(
        "shared-client",
        { sequence: 1, action: "fast", ok: true, message: "old receipt" },
        "connection-a",
      ),
    ).toEqual({ ok: false });
    expect(
      service.recordResult(
        "shared-client",
        { sequence: 2, action: "fast", ok: true, message: "new receipt" },
        "connection-b",
      ),
    ).toEqual({ ok: true });
  });

  it("invalidates receipts on release and controller expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const { service, transport } = createHarness();
    await service.start();
    expect(service.syncUi(focusedSnapshot("client-a"), "connection-a").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(service.releaseUi("client-a", "connection-a").ok).toBe(true);
    expect(
      service.recordResult(
        "client-a",
        { sequence: 1, action: "fast", ok: true, message: "ok" },
        "connection-a",
      ),
    ).toEqual({ ok: false });

    expect(service.syncUi(focusedSnapshot("client-a"), "connection-a").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    vi.setSystemTime(new Date("2026-10-13T12:00:10Z"));
    expect(
      service.recordResult(
        "client-a",
        { sequence: 2, action: "fast", ok: true, message: "ok" },
        "connection-a",
      ),
    ).toEqual({ ok: false });
  });

  it("lets a new focused controller take over after the previous ten-second lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const { service, transport, events } = createHarness();
    await service.start();
    expect(service.syncUi(focusedSnapshot("client-a"), "connection-a").ok).toBe(true);
    expect(service.syncUi(focusedSnapshot("client-b"), "connection-b").ok).toBe(false);

    vi.setSystemTime(new Date("2026-10-13T12:00:10Z"));
    const slots = emptyMicroSlots();
    slots[0] = selectedSlot(0, "session-b");
    expect(service.syncUi(focusedSnapshot("client-b", slots), "connection-b").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT12", act: 1 });

    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      clientId: "client-b",
      sessionKey: "session-b",
    });
  });

  it("preserves unknown Input Monitoring permission after a healthy status round trip", async () => {
    const transport = new FakeTransport();
    transport.permission = "unknown";
    const { service } = createHarness(transport);
    await service.start();
    expect(service.getDevice()).toMatchObject({ connected: true, inputPermission: "unknown" });
  });

  it("fails closed on preference read errors and recovers after settings save without restarting", async () => {
    const readError =
      "Saved Codex Micro preferences are invalid. Reset the layout from its settings page.";
    const warnings: string[] = [];
    let writeError: string | null = "Settings storage is unavailable.";
    const { service, transport, events } = createHarness(
      new FakeTransport(),
      undefined,
      async () => {
        if (writeError) {
          throw new Error(writeError);
        }
      },
      async () => {
        throw new Error(readError);
      },
      { warn: (message) => warnings.push(message) },
    );

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.getPreferences()).toEqual(defaultMicroPreferences());
    expect(service.getDevice()).toMatchObject({ connected: true, error: readError });
    expect(warnings).toContain(
      `Could not load Codex Micro preferences; physical input is disabled until settings are saved: ${readError}`,
    );

    const slots = emptyMicroSlots();
    slots[0] = selectedSlot(0, "session-a");
    expect(service.syncUi(focusedSnapshot("client-a", slots), "connection-a").ok).toBe(true);
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(events.filter((event) => event.event === "input")).toHaveLength(0);

    await expect(
      service.setPreferences({ ...defaultMicroPreferences(), brightness: 60 }),
    ).rejects.toThrow("Settings storage is unavailable.");
    expect(service.getPreferences()).toEqual(defaultMicroPreferences());
    expect(service.getDevice().error).toBe(readError);
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(events.filter((event) => event.event === "input")).toHaveLength(0);

    writeError = null;
    await expect(
      service.setPreferences({ ...defaultMicroPreferences(), brightness: 60 }),
    ).resolves.toMatchObject({ brightness: 60 });
    expect(service.getDevice().error).toBeNull();
    transport.emit({ kind: "key", key: "ACT06", act: 1 });
    expect(events.findLast((event) => event.event === "input")?.payload).toMatchObject({
      clientId: "client-a",
      sessionKey: "session-a",
    });
  });

  it("serializes overlapping preference saves in request order", async () => {
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const persisted: number[] = [];
    const savePreferences: MicroServiceOptions["savePreferences"] = async (preferences) => {
      persisted.push(preferences.brightness);
      if (persisted.length === 1) {
        await firstSave;
      }
    };
    const { service } = createHarness(new FakeTransport(), () => undefined, savePreferences);
    await service.start();
    const firstPreferences = { ...defaultMicroPreferences(), brightness: 60 };
    const secondPreferences = { ...defaultMicroPreferences(), brightness: 40 };
    const first = service.setPreferences(firstPreferences);
    const second = service.setPreferences(secondPreferences);
    await Promise.resolve();
    await Promise.resolve();
    expect(persisted).toEqual([60]);

    releaseFirstSave();
    await Promise.all([first, second]);
    expect(persisted).toEqual([60, 40]);
    expect(service.getPreferences().brightness).toBe(40);
  });

  it("retries discovery so a device attached after service startup is found", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    transport.connectFailures = 1;
    const { service } = createHarness(transport);
    await service.start();
    expect(service.getDevice().connected).toBe(false);
    expect(transport.connectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.getDevice()).toMatchObject({ connected: true, firmware: "0.4.1" });
    expect(transport.connectCalls).toBe(2);
  });

  it("fully blanks at the configured inactivity timeout and wakes only for meaningful stick movement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const { service, transport } = createHarness();
    await service.start();
    expect(service.getPreferences()).toEqual(defaultMicroPreferences());

    await vi.advanceTimersByTimeAsync(180_000);
    expect(service.getDevice().dimmed).toBe(true);
    expect(transport.lighting.at(-1)).toEqual({
      ambient: { e: 0, b: 0, s: 0, m: 0, c: 0 },
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
      slots: Array.from({ length: 6 }, (_, id) => ({ id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 })),
    });

    transport.emit({ kind: "radial", angle: 0.2, distance: 0.1 });
    expect(service.getDevice().dimmed).toBe(true);
    transport.emit({ kind: "radial", angle: 0.2, distance: 0.11 });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getDevice().dimmed).toBe(false);
    expect(transport.lighting.at(-1)?.ambient).toEqual({ e: 0, b: 0, s: 0, m: 0, c: 0 });
  });
});

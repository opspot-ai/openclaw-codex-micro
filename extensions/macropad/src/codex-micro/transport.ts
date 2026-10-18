import { randomInt } from "node:crypto";
import type { FactoryLighting } from "../lighting.js";
import {
  HidDevice,
  findDevice,
  inspectInputMonitoringPermission,
  ioReturnHex,
  isDarwinHidAvailable,
  kCFRunLoopRunHandledSource,
  kIOReturnSuccess,
  pump,
  shutdownManager,
  type HidDeviceInfo,
  type InputPermission,
} from "./hid-darwin.js";
import {
  MAX_RPC_ID,
  MessageReassembler,
  REPORT_ID,
  RpcCorrelator,
  encodeRequest,
  parseRpcMessage,
  type MicroTransportKind,
} from "./protocol.js";

const CODEX_MICRO_VENDOR_ID = 0x303a;
const CODEX_MICRO_PRODUCT_ID = 0x8360;

const ALLOWED_MICRO_METHODS: ReadonlySet<string> = new Set([
  "device.status",
  "sys.version",
  "v.oai.rgbcfg",
  "v.oai.thstatus",
]);

const CONNECT_TIMEOUT_MS = 3_000;
const RPC_TIMEOUT_MS = 1_500;
const PUMP_INTERVAL_MS = 8;
const PUMP_SLICE_SECONDS = 0.001;

type DeviceStatus = {
  version?: string;
  battery?: number;
  isCharging?: boolean;
};

export type MicroHardwareInfo = {
  product: string | null;
  firmware: string | null;
  transport: MicroTransportKind | null;
  battery: number | null;
  charging: boolean;
};

export type DeviceInput =
  | { kind: "key"; key: string; act: number }
  | { kind: "radial"; angle: number; distance: number };

export type MicroTransportPort = {
  readonly supported: boolean;
  inspectPermission(): InputPermission;
  onInput(listener: (event: DeviceInput) => void): () => void;
  connect(): Promise<MicroHardwareInfo>;
  status(): Promise<DeviceStatus>;
  setLighting(lighting: FactoryLighting): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
};

export class MicroTransportError extends Error {
  readonly permission?: InputPermission;
  readonly info?: HidDeviceInfo;

  constructor(
    message: string,
    options: { permission?: InputPermission; info?: HidDeviceInfo } = {},
  ) {
    super(message);
    this.name = "MicroTransportError";
    this.permission = options.permission;
    this.info = options.info;
  }
}

class ForbiddenMicroMethodError extends Error {
  constructor(method: string) {
    super(
      `Refusing Codex Micro method ${JSON.stringify(method)}; it is outside the read and lighting allowlist.`,
    );
    this.name = "ForbiddenMicroMethodError";
  }
}

function parseDeviceStatus(value: unknown): DeviceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  // SAFETY: Only non-array objects reach this read-only projection of JSON status fields.
  const fields = value as Record<string, unknown>;
  return {
    ...(typeof fields.version === "string" ? { version: fields.version.slice(0, 128) } : {}),
    ...(typeof fields.battery === "number" && Number.isFinite(fields.battery)
      ? { battery: Math.max(0, Math.min(100, fields.battery)) }
      : {}),
    ...(typeof fields.is_charging === "boolean" ? { isCharging: fields.is_charging } : {}),
  };
}

function normalizeTransport(value: string | null): MicroTransportKind | null {
  if (value === "USB") {
    return "USB";
  }
  if (value === "Bluetooth Low Energy" || value === "Bluetooth") {
    return "BLE";
  }
  return null;
}

function toHardwareInfo(info: HidDeviceInfo, status: DeviceStatus): MicroHardwareInfo {
  return {
    product: info.product?.slice(0, 128) ?? null,
    firmware: status.version ?? null,
    transport: normalizeTransport(info.transport),
    battery: status.battery ?? null,
    charging: status.isCharging ?? false,
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 512);
  }
  return String(error).slice(0, 512);
}

/**
 * macOS transport for Report 6. The device opens non-exclusively so another
 * authorized host app can continue to see it; RPC replies are correlated by id
 * and, when firmware echoes it, exact method name.
 */
class CodexMicroTransport implements MicroTransportPort {
  readonly supported = isDarwinHidAvailable();
  readonly #listeners = new Set<(event: DeviceInput) => void>();
  readonly #reassembler = new MessageReassembler();
  readonly #correlator = new RpcCorrelator({ startId: randomInt(0, MAX_RPC_ID) });
  #device: HidDevice | null = null;
  #pumpTimer: ReturnType<typeof setInterval> | null = null;
  #requestQueue: Promise<void> = Promise.resolve();
  #generation = 0;

  inspectPermission(): InputPermission {
    return this.supported ? inspectInputMonitoringPermission() : "unsupported";
  }

  onInput(listener: (event: DeviceInput) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<MicroHardwareInfo> {
    if (!this.supported) {
      throw new MicroTransportError("The Codex Micro HID transport is unavailable on this host.");
    }
    if (this.#device?.isOpen) {
      throw new MicroTransportError("Codex Micro transport is already connected.");
    }

    const info = findDevice({ vendorId: CODEX_MICRO_VENDOR_ID, productId: CODEX_MICRO_PRODUCT_ID });
    if (!info) {
      throw new MicroTransportError("Codex Micro was not found.", {
        permission: this.inspectPermission(),
      });
    }
    const permission = this.inspectPermission();
    if (permission === "denied") {
      throw new MicroTransportError(
        "Input Monitoring is denied for OpenClaw. Enable it in System Settings > Privacy & Security > Input Monitoring.",
        { permission, info },
      );
    }

    const device = new HidDevice(info);
    // Publish the handle before any operation that can fail so the common
    // teardown path closes it even when callback registration fails partway.
    this.#device = device;
    try {
      device.open();
      device.startReading((reportId, data) => this.#ingest(reportId, data));
      this.#reassembler.reset();
      this.#startPump();
      const status = await this.#request("device.status", undefined, CONNECT_TIMEOUT_MS);
      const details = parseDeviceStatus(status);
      if (!details.version) {
        try {
          const version = await this.#request("sys.version", undefined, CONNECT_TIMEOUT_MS);
          if (
            typeof version === "object" &&
            version !== null &&
            "version" in version &&
            typeof version.version === "string"
          ) {
            details.version = version.version.slice(0, 128);
          }
        } catch {
          // device.status already established a correlated healthy connection.
        }
      }
      return toHardwareInfo(info, details);
    } catch (error) {
      await this.disconnect();
      const currentPermission = this.inspectPermission();
      throw new MicroTransportError(safeErrorMessage(error), {
        permission: currentPermission,
        info,
      });
    }
  }

  async status(): Promise<DeviceStatus> {
    return parseDeviceStatus(await this.#request("device.status", undefined, RPC_TIMEOUT_MS));
  }

  async setLighting(lighting: FactoryLighting): Promise<void> {
    await this.#request(
      "v.oai.rgbcfg",
      { ambient: lighting.ambient, keys: lighting.keys },
      RPC_TIMEOUT_MS,
    );
    await this.#request("v.oai.thstatus", lighting.slots, RPC_TIMEOUT_MS);
  }

  async disconnect(): Promise<void> {
    this.#generation++;
    this.#stopPump();
    this.#correlator.rejectAll("Codex Micro transport disconnected");
    try {
      this.#device?.close();
    } finally {
      this.#device = null;
      this.#reassembler.reset();
      shutdownManager();
    }
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    this.#listeners.clear();
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!ALLOWED_MICRO_METHODS.has(method)) {
      return Promise.reject(new ForbiddenMicroMethodError(method));
    }
    const generation = this.#generation;
    const operation = this.#requestQueue.then(() =>
      this.#sendRequest(generation, method, params, timeoutMs),
    );
    this.#requestQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #sendRequest(
    generation: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (generation !== this.#generation || !this.#device?.isOpen) {
      throw new MicroTransportError("Codex Micro transport is not open.");
    }
    const transport = normalizeTransport(this.#device.info.transport);
    if (!transport) {
      throw new MicroTransportError(
        "Codex Micro transport type is unknown; refusing to guess report framing.",
      );
    }
    const id = this.#correlator.allocateId();
    const response = this.#correlator.register(id, method, timeoutMs);
    response.catch(() => undefined);
    try {
      for (const packet of encodeRequest(method, params, id, transport)) {
        if (generation !== this.#generation || !this.#device?.isOpen) {
          throw new MicroTransportError(
            "Codex Micro transport closed before the request was sent.",
          );
        }
        const result = this.#device.setOutputReport(packet);
        if (result !== kIOReturnSuccess) {
          throw new MicroTransportError(`IOHIDDeviceSetReport failed: ${ioReturnHex(result)}`);
        }
      }
    } catch (error) {
      this.#correlator.cancel(id);
      throw error;
    }
    const result = await response;
    if (generation !== this.#generation) {
      throw new MicroTransportError("Codex Micro transport changed before its reply arrived.");
    }
    return result;
  }

  #ingest(reportId: number, data: Uint8Array): void {
    if (reportId !== REPORT_ID) {
      return;
    }
    let messages;
    try {
      messages = this.#reassembler.push(reportId, data);
    } catch {
      this.#reassembler.reset();
      return;
    }
    for (const message of messages) {
      if (message.channel !== 2) {
        continue;
      }
      const rpc = parseRpcMessage(message.text);
      if (!rpc) {
        continue;
      }
      if (rpc.kind === "response") {
        this.#correlator.settle(rpc);
      } else {
        this.#dispatchNotification(rpc.method, rpc.params);
      }
    }
  }

  #dispatchNotification(method: string, params: unknown): void {
    let input: DeviceInput | null = null;
    if (
      method === "v.oai.hid" &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params)
    ) {
      // SAFETY: HID notification params are JSON objects; arrays and primitives are rejected above.
      const value = params as Record<string, unknown>;
      if (
        (typeof value.k === "string" || typeof value.k === "number") &&
        typeof value.act === "number" &&
        Number.isFinite(value.act)
      ) {
        input = { kind: "key", key: String(value.k).slice(0, 64), act: value.act };
      }
    } else if (
      method === "v.oai.rad" &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params)
    ) {
      // SAFETY: Radial notification params are JSON objects; arrays and primitives are rejected above.
      const value = params as Record<string, unknown>;
      if (
        typeof value.a === "number" &&
        Number.isFinite(value.a) &&
        typeof value.d === "number" &&
        Number.isFinite(value.d)
      ) {
        input = { kind: "radial", angle: value.a, distance: value.d };
      }
    }
    if (!input) {
      return;
    }
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      try {
        listener(input);
      } catch {
        // Native callbacks must not unwind through koffi or stop other listeners.
      }
    }
  }

  #startPump(): void {
    if (this.#pumpTimer) {
      return;
    }
    this.#pumpTimer = setInterval(() => {
      try {
        for (let index = 0; index < 32; index++) {
          if (pump(PUMP_SLICE_SECONDS) !== kCFRunLoopRunHandledSource) {
            break;
          }
        }
      } catch {
        // The next correlated status request reports a stale or removed device.
      }
    }, PUMP_INTERVAL_MS);
  }

  #stopPump(): void {
    if (!this.#pumpTimer) {
      return;
    }
    clearInterval(this.#pumpTimer);
    this.#pumpTimer = null;
  }
}

export function createCodexMicroTransport(): MicroTransportPort {
  return new CodexMicroTransport();
}

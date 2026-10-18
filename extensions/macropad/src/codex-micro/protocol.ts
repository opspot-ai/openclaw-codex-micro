export const REPORT_ID = 0x06;
const REPORT_SIZE = 64;
const USB_REPORT_SIZE = 63;
const MAX_FRAGMENT_BYTES = 61;
export const MAX_RPC_ID = 999;
const MAX_MESSAGE_BYTES = 8 * 1024;

export type MicroTransportKind = "USB" | "BLE";
export type WirePacket = Uint8Array;

class MicroProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicroProtocolError";
  }
}

export type RpcResponse = {
  kind: "response";
  id: number;
  method?: string;
  result?: unknown;
  error?: unknown;
};

type RpcNotification = { kind: "notification"; method: string; params?: unknown };
export type RpcMessage = RpcResponse | RpcNotification;

export type ReassembledMessage = { channel: number; text: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function assertRpcId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= MAX_RPC_ID) {
    throw new MicroProtocolError(`RPC id must be in [0, ${MAX_RPC_ID}), got ${String(id)}`);
  }
}

export function encodeRequest(
  method: string,
  params: unknown,
  id: number,
  transport: MicroTransportKind,
): WirePacket[] {
  assertRpcId(id);
  if (!method) {
    throw new MicroProtocolError("RPC method must not be empty");
  }
  const bytes = encoder.encode(`${JSON.stringify({ method, params: params ?? null, id })}\r\n`);
  const packets: WirePacket[] = [];
  for (
    let offset = 0;
    offset < bytes.length || packets.length === 0;
    offset += MAX_FRAGMENT_BYTES
  ) {
    const fragment = bytes.subarray(offset, offset + MAX_FRAGMENT_BYTES);
    const packet = new Uint8Array(REPORT_SIZE);
    packet[0] = REPORT_ID;
    packet[1] = 2;
    packet[2] = fragment.length;
    packet.set(fragment, 3);
    packets.push(transport === "USB" ? packet.subarray(1) : packet);
  }
  return packets;
}

function decodePayload(
  reportId: number,
  data: Uint8Array,
): { channel: number; payload: Uint8Array } | null {
  if (reportId !== REPORT_ID) {
    return null;
  }
  let body = data;
  if (data.length === REPORT_SIZE) {
    if (data[0] !== REPORT_ID) {
      throw new MicroProtocolError("HID report id prefix did not match");
    }
    body = data.subarray(1);
  } else if (data.length !== USB_REPORT_SIZE) {
    throw new MicroProtocolError(`HID input report had ${data.length} bytes; expected 63 or 64`);
  }
  const channel = body[0];
  const length = body[1];
  if (
    channel === undefined ||
    length === undefined ||
    length > MAX_FRAGMENT_BYTES ||
    length + 2 > body.length
  ) {
    throw new MicroProtocolError("HID input report had an invalid fragment length");
  }
  return { channel, payload: body.subarray(2, 2 + length) };
}

export class MessageReassembler {
  readonly #buffers = new Map<number, Uint8Array>();

  push(reportId: number, data: Uint8Array): ReassembledMessage[] {
    const decoded = decodePayload(reportId, data);
    return decoded ? this.pushPayload(decoded.channel, decoded.payload) : [];
  }

  pushPayload(channel: number, payload: Uint8Array): ReassembledMessage[] {
    const previous = this.#buffers.get(channel) ?? new Uint8Array(0);
    const bytes = new Uint8Array(previous.length + payload.length);
    bytes.set(previous);
    bytes.set(payload, previous.length);
    const messages: ReassembledMessage[] = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      const end = index > start && bytes[index - 1] === 0x0d ? index - 1 : index;
      if (end > start) {
        messages.push({ channel, text: decoder.decode(bytes.subarray(start, end)) });
      }
      start = index + 1;
    }
    const remainder = bytes.subarray(start);
    if (remainder.length > MAX_MESSAGE_BYTES) {
      this.#buffers.delete(channel);
      throw new MicroProtocolError(`RPC fragment buffer exceeded ${MAX_MESSAGE_BYTES} bytes`);
    }
    this.#buffers.set(channel, remainder.slice());
    return messages;
  }

  reset(): void {
    this.#buffers.clear();
  }
}

export function parseRpcMessage(text: string): RpcMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // SAFETY: JSON.parse returns plain objects here; arrays and primitives were rejected above.
  const record = value as Record<string, unknown>;

  const responseId = typeof record.id === "number" ? record.id : record.i;
  if (typeof responseId === "number" && Number.isInteger(responseId)) {
    const responseMethod = record.method ?? record.m;
    if (responseMethod !== undefined && typeof responseMethod !== "string") {
      return null;
    }
    return {
      kind: "response",
      id: responseId,
      ...(typeof responseMethod === "string" ? { method: responseMethod } : {}),
      ...(Object.hasOwn(record, "result")
        ? { result: record.result }
        : Object.hasOwn(record, "p")
          ? { result: record.p }
          : {}),
      ...(Object.hasOwn(record, "error") ? { error: record.error } : {}),
    };
  }
  if (typeof record.method === "string") {
    return { kind: "notification", method: record.method, params: record.params };
  }
  if (typeof record.m === "string") {
    return { kind: "notification", method: record.m, params: record.p };
  }
  return null;
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CorrelatorOptions = {
  startId?: number;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
};

export class RpcCorrelator {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #setTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  readonly #clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  #nextId: number;

  constructor(options: CorrelatorOptions = {}) {
    this.#nextId = options.startId ?? Math.floor(Math.random() * MAX_RPC_ID);
    assertRpcId(this.#nextId);
    this.#setTimeout = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimeout = options.clearTimeoutFn ?? clearTimeout;
  }

  allocateId(): number {
    for (let attempt = 0; attempt < MAX_RPC_ID; attempt++) {
      const id = this.#nextId;
      this.#nextId = (id + 1) % MAX_RPC_ID;
      if (!this.#pending.has(id)) {
        return id;
      }
    }
    throw new MicroProtocolError("All device RPC ids are in flight");
  }

  register(id: number, method: string, timeoutMs: number): Promise<unknown> {
    assertRpcId(id);
    if (this.#pending.has(id)) {
      throw new MicroProtocolError(`RPC id ${id} is already in flight`);
    }
    return new Promise((resolve, reject) => {
      const timer = this.#setTimeout(() => {
        this.#pending.delete(id);
        reject(new MicroProtocolError(`No correlated reply to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
  }

  cancel(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  settle(response: RpcResponse): "settled" | "unmatched" | "method-mismatch" {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      return "unmatched";
    }
    if (response.method !== undefined && response.method !== pending.method) {
      return "method-mismatch";
    }
    this.#clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    if (response.error !== undefined && response.error !== null) {
      pending.reject(
        new MicroProtocolError(`Device rejected ${pending.method}: ${safeError(response.error)}`),
      );
    } else {
      pending.resolve(response.result);
    }
    return "settled";
  }

  rejectAll(reason: string): void {
    for (const [id, pending] of this.#pending) {
      this.#clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new MicroProtocolError(reason));
    }
  }
}

function safeError(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 256);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message.slice(0, 256);
  }
  return "unknown device error";
}

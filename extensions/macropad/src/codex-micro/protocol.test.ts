import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageReassembler, RpcCorrelator, encodeRequest, parseRpcMessage } from "./protocol.js";

afterEach(() => vi.useRealTimers());

describe("Codex Micro Report 6 protocol", () => {
  it("uses distinct USB and BLE output framing", () => {
    const usb = encodeRequest("device.status", null, 7, "USB")[0]!;
    const ble = encodeRequest("device.status", null, 7, "BLE")[0]!;

    expect(usb).toHaveLength(63);
    expect(usb[0]).toBe(2);
    expect(ble).toHaveLength(64);
    expect(Array.from(ble.subarray(0, 3))).toEqual([6, usb[0], usb[1]]);
    expect(usb[1]).toBeGreaterThan(0);
  });

  it("reassembles bounded multi-report messages and recognizes compact notifications", () => {
    const longParams = { text: "x".repeat(200) };
    const packets = encodeRequest("device.status", longParams, 8, "USB");
    const reassembler = new MessageReassembler();
    const messages = packets.flatMap((packet) => reassembler.push(6, packet));

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.text)).toEqual({
      method: "device.status",
      params: longParams,
      id: 8,
    });
    expect(parseRpcMessage('{"m":"v.oai.hid","p":{"k":"ACT06","act":1}}')).toEqual({
      kind: "notification",
      method: "v.oai.hid",
      params: { k: "ACT06", act: 1 },
    });
  });

  it("does not settle a shared-client reply when its echoed method differs", async () => {
    const correlator = new RpcCorrelator({ startId: 11 });
    const request = correlator.register(11, "device.status", 500);
    const observed = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect(
      correlator.settle({ kind: "response", id: 11, method: "sys.version", result: "wrong" }),
    ).toBe("method-mismatch");
    expect(
      correlator.settle({
        kind: "response",
        id: 11,
        method: "device.status",
        result: { battery: 70 },
      }),
    ).toBe("settled");
    await expect(observed).resolves.toEqual({ value: { battery: 70 } });
  });

  it("parses compact RPC replies with numeric i and echoed compact m", () => {
    expect(parseRpcMessage('{"i":12,"m":"device.status","p":{"battery":67}}')).toEqual({
      kind: "response",
      id: 12,
      method: "device.status",
      result: { battery: 67 },
    });
  });

  it("correlates compact echoed methods and refuses a mismatched compact reply", async () => {
    const correlator = new RpcCorrelator({ startId: 12 });
    const request = correlator.register(12, "device.status", 500);
    const observed = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    const mismatched = parseRpcMessage('{"i":12,"m":"sys.version","p":"wrong"}');
    expect(mismatched?.kind).toBe("response");
    if (mismatched?.kind !== "response") {
      throw new Error("compact reply did not parse");
    }
    expect(correlator.settle(mismatched)).toBe("method-mismatch");

    const response = parseRpcMessage('{"i":12,"m":"device.status","p":{"battery":67}}');
    expect(response?.kind).toBe("response");
    if (response?.kind !== "response") {
      throw new Error("compact reply did not parse");
    }
    expect(correlator.settle(response)).toBe("settled");
    await expect(observed).resolves.toEqual({ value: { battery: 67 } });
  });

  it("rejects oversized fragments without retaining an unbounded partial message", () => {
    const reassembler = new MessageReassembler();
    expect(() => reassembler.pushPayload(2, new Uint8Array(8 * 1024 + 1).fill(65))).toThrow(
      /exceeded 8192 bytes/u,
    );
    expect(reassembler.pushPayload(2, new Uint8Array([123, 125, 10]))).toEqual([
      { channel: 2, text: "{}" },
    ]);
  });
});

import {
  emptyMicroSlots,
  type MicroDevice,
  type MicroPreferences,
  type MicroSlot,
} from "../contract.js";
import type { MicroHardwareInfo } from "./codex-micro/transport.js";
import type { FactoryLighting } from "./lighting.js";

export type MicroVoiceState = "idle" | "recording" | "processing" | "completed";
export type MicroAutoDim =
  | "off"
  | "30-seconds"
  | "1-minute"
  | "3-minutes"
  | "10-minutes"
  | "30-minutes"
  | "1-hour";

export const DIM_DELAY_MS: Record<MicroAutoDim, number | null> = {
  off: null,
  "30-seconds": 30_000,
  "1-minute": 60_000,
  "3-minutes": 180_000,
  "10-minutes": 600_000,
  "30-minutes": 1_800_000,
  "1-hour": 3_600_000,
};

export function copyPreferences(preferences: MicroPreferences): MicroPreferences {
  return {
    ...preferences,
    customSessionKeys: [...preferences.customSessionKeys],
    bindings: Object.fromEntries(
      Object.entries(preferences.bindings).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

export function copySlots(slots: readonly MicroSlot[]): MicroSlot[] {
  const empty = emptyMicroSlots();
  return Array.from({ length: 6 }, (_, id) => {
    const slot = slots.find((candidate) => candidate.id === id);
    return slot ? { ...slot } : empty[id]!;
  });
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function initialDevice(permission: MicroDevice["inputPermission"]): MicroDevice {
  return {
    connected: false,
    product: null,
    firmware: null,
    transport: null,
    battery: null,
    charging: false,
    inputPermission: permission,
    error: null,
    inputCount: 0,
    dimmed: false,
  };
}

export function hardwareFields(
  info: MicroHardwareInfo,
): Pick<MicroDevice, "product" | "firmware" | "transport" | "battery" | "charging"> {
  return {
    product: info.product,
    firmware: info.firmware,
    transport: info.transport,
    battery: info.battery,
    charging: info.charging,
  };
}

export function identifyLighting(brightness: number): FactoryLighting {
  const value = brightness / 100;
  return {
    ambient: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      c: 0xffffff,
      b: value,
      e: 1,
      s: 0,
      sk: 0,
      sa: 0,
    })),
  };
}

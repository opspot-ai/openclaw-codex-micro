import type { MicroPreferences, MicroSlot, SlotStatus } from "../contract.js";

const EFFECT_OFF = 0;
const EFFECT_SOLID = 1;
const EFFECT_SNAKE = 2;
const EFFECT_BREATH = 4;

const COLORS: Record<Exclude<SlotStatus, "off">, number> = {
  idle: 0xffffff,
  working: 0x304ffe,
  unread: 0x00ff4c,
  "awaiting-approval": 0xff6d00,
  "awaiting-response": 0xff6d00,
  error: 0xff0033,
};

type MicroKeyLight = {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
  sk: number;
  sa: number;
};

type MicroZoneLight = { e: number; b: number; s: number; m: number; c: number };

export type FactoryLighting = {
  ambient: MicroZoneLight;
  keys: MicroZoneLight;
  slots: MicroKeyLight[];
};

export type FactoryLightingInput = {
  slots: readonly MicroSlot[];
  voiceState: "idle" | "recording" | "processing" | "completed";
  preferences: MicroPreferences;
  now: number;
  selectionChangedAt: number | null;
  dimmed: boolean;
};

const offZone = (): MicroZoneLight => ({ e: EFFECT_OFF, b: 0, s: 0, m: 0, c: 0 });

function statusColor(status: SlotStatus): number {
  return status === "off" ? 0 : COLORS[status];
}

function zone(effect: number, color: number, brightness: number, speed = 0): MicroZoneLight {
  return { e: effect, b: brightness, s: speed, m: 0, c: color };
}

export function composeFactoryLighting(input: FactoryLightingInput): FactoryLighting {
  const brightness = input.preferences.brightness / 100;
  const selected = input.slots.find((slot) => slot.selected);
  const withinSelectionFlash =
    selected?.sessionKey !== null &&
    selected?.sessionKey !== undefined &&
    input.selectionChangedAt !== null &&
    input.now >= input.selectionChangedAt &&
    input.now - input.selectionChangedAt < 4_000;

  const slots = Array.from({ length: 6 }, (_, id): MicroKeyLight => {
    const slot = input.slots.find((candidate) => candidate.id === id);
    if (!slot || slot.status === "off") {
      return { id, c: 0, b: 0, e: EFFECT_OFF, s: 0, sk: 0, sa: 0 };
    }
    return {
      id,
      c: statusColor(slot.status),
      b: brightness,
      e: slot.selected ? EFFECT_BREATH : EFFECT_SOLID,
      s: slot.selected ? 0.4 : 0,
      sk: 0,
      sa: 0,
    };
  });

  if (input.dimmed) {
    return {
      ambient: offZone(),
      keys: offZone(),
      slots: slots.map((slot) => ({ ...slot, c: 0, b: 0, e: EFFECT_OFF, s: 0 })),
    };
  }

  let ambient = offZone();
  if (input.voiceState === "recording") {
    ambient = zone(EFFECT_SNAKE, 0x2e8b57, brightness, 0.4);
  } else if (input.voiceState === "processing") {
    ambient = zone(EFFECT_SNAKE, 0xffffff, brightness, 0.4);
  } else if (input.voiceState === "completed") {
    ambient = zone(EFFECT_SOLID, 0xffffff, brightness);
  } else if (selected?.status === "working") {
    ambient = zone(EFFECT_SNAKE, 0x304ffe, brightness, 0.4);
  } else if (withinSelectionFlash && selected) {
    ambient = zone(EFFECT_SOLID, statusColor(selected.status), brightness);
  }

  const keys = withinSelectionFlash ? zone(EFFECT_SOLID, ambient.c, ambient.b) : offZone();
  return { ambient, keys, slots };
}

export function lightingFingerprint(lighting: FactoryLighting): string {
  return JSON.stringify(lighting);
}

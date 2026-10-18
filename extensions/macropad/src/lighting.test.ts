import { describe, expect, it } from "vitest";
import { defaultMicroPreferences, emptyMicroSlots } from "../contract.js";
import { composeFactoryLighting } from "./lighting.js";

describe("factory Codex Micro lighting", () => {
  it("paints a complete six-key frame with the shipped status colors", () => {
    const slots = emptyMicroSlots();
    const statuses = ["idle", "working", "unread", "awaiting-approval", "error", "off"] as const;
    for (const [id, status] of statuses.entries()) {
      slots[id] = { ...slots[id]!, sessionKey: `thread-${id}`, status, selected: false };
    }

    const frame = composeFactoryLighting({
      slots: slots.toReversed(),
      voiceState: "idle",
      preferences: defaultMicroPreferences(),
      now: 0,
      selectionChangedAt: null,
      dimmed: false,
    });

    expect(frame.slots).toHaveLength(6);
    expect(frame.slots.map((slot) => [slot.id, slot.c, slot.e, slot.b])).toEqual([
      [0, 0xffffff, 1, 1],
      [1, 0x304ffe, 1, 1],
      [2, 0x00ff4c, 1, 1],
      [3, 0xff6d00, 1, 1],
      [4, 0xff0033, 1, 1],
      [5, 0, 0, 0],
    ]);
    expect(frame.ambient).toEqual({ e: 0, b: 0, s: 0, m: 0, c: 0 });
    expect(frame.keys).toEqual(frame.ambient);
  });

  it("breathes the selected key and flashes matching solid ambient and key zones for four seconds", () => {
    const slots = emptyMicroSlots();
    slots[2] = {
      id: 2,
      sessionKey: "thread-working",
      title: "Working",
      status: "working",
      selected: true,
    };
    const input = {
      slots,
      voiceState: "idle" as const,
      preferences: defaultMicroPreferences(),
      now: 3999,
      selectionChangedAt: 0,
      dimmed: false,
    };

    const flashing = composeFactoryLighting(input);
    expect(flashing.slots[2]).toMatchObject({ c: 0x304ffe, e: 4, s: 0.4 });
    expect(flashing.ambient).toEqual({ e: 2, b: 1, s: 0.4, m: 0, c: 0x304ffe });
    expect(flashing.keys).toEqual({ e: 1, b: 1, s: 0, m: 0, c: 0x304ffe });

    const expired = composeFactoryLighting({ ...input, now: 4000 });
    expect(expired.ambient).toEqual(flashing.ambient);
    expect(expired.keys).toEqual({ e: 0, b: 0, s: 0, m: 0, c: 0 });
  });

  it("gives voice lighting precedence and blanks every surface when dimmed", () => {
    const slots = emptyMicroSlots();
    slots[0] = {
      id: 0,
      sessionKey: "thread-a",
      title: "A",
      status: "idle",
      selected: true,
    };
    const base = {
      slots,
      preferences: defaultMicroPreferences(),
      now: 1_000,
      selectionChangedAt: 0,
      dimmed: false,
    };
    const recording = composeFactoryLighting({ ...base, voiceState: "recording" });
    expect(recording.ambient).toEqual({ e: 2, b: 1, s: 0.4, m: 0, c: 0x2e8b57 });
    expect(recording.keys).toEqual({ e: 1, b: 1, s: 0, m: 0, c: 0x2e8b57 });

    const dimmed = composeFactoryLighting({ ...base, voiceState: "processing", dimmed: true });
    expect(dimmed.ambient).toEqual({ e: 0, b: 0, s: 0, m: 0, c: 0 });
    expect(dimmed.keys).toEqual(dimmed.ambient);
    expect(dimmed.slots.every((slot) => slot.e === 0 && slot.b === 0 && slot.c === 0)).toBe(true);
  });
});

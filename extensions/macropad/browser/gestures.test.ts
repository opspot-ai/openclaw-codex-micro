import { describe, expect, it } from "vitest";
import { defaultMicroPreferences, type MicroInput } from "../contract.js";
import { MicroGestureDecoder, type MicroGesture } from "./gestures.js";

class FakeTimers {
  current = 0;
  nextId = 1;
  jobs = new Map<number, { at: number; callback: () => void }>();

  port = {
    now: () => this.current,
    set: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.jobs.set(id, { at: this.current + delayMs, callback });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clear: (timer: ReturnType<typeof globalThis.setTimeout>) => {
      this.jobs.delete(timer as unknown as number);
    },
  };

  advance(milliseconds: number): void {
    const end = this.current + milliseconds;
    while (true) {
      const next = [...this.jobs.entries()].toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {
        break;
      }
      this.jobs.delete(next[0]);
      this.current = next[1].at;
      next[1].callback();
    }
    this.current = end;
  }
}

function keyInput(
  sequence: number,
  key: string,
  act: number,
  sessionKey: string | null,
): MicroInput {
  return {
    clientId: "client",
    connectionId: "connection-test",
    sequence,
    kind: "key",
    key,
    act,
    sessionKey,
  };
}

function radialInput(
  sequence: number,
  angle: number,
  distance: number,
  sessionKey: string | null,
): MicroInput {
  return {
    clientId: "client",
    connectionId: "connection-test",
    sequence,
    kind: "radial",
    angle,
    distance,
    sessionKey,
  };
}

describe("Codex Micro browser gesture decoding", () => {
  it("opens the captured agent slot immediately on key-down", () => {
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture));
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "AG00", 1, "agent:main:first"), preferences);
    decoder.handle(keyInput(2, "AG00", 0, "agent:main:changed"), preferences);

    expect(gestures).toEqual([
      {
        sequence: 1,
        action: "agent-open",
        sessionKey: "agent:main:first",
        source: "AG00",
        agentTap: "single",
      },
    ]);
  });

  it("focuses only a second same-slot, same-session press within 350 ms", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "AG03", 1, "agent:main:work"), preferences);
    decoder.handle(keyInput(2, "AG03", 0, "agent:main:work"), preferences);
    timers.advance(350);
    decoder.handle(keyInput(3, "AG03", 1, "agent:main:work"), preferences);
    decoder.handle(keyInput(4, "AG03", 0, "agent:main:work"), preferences);

    expect(gestures.map(({ sequence, action, agentTap }) => [sequence, action, agentTap])).toEqual([
      [1, "agent-open", "single"],
      [3, "agent-focus", "double"],
    ]);
  });

  it("does not treat another slot or changed event-time session as a double press", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "AG00", 1, "agent:main:first"), preferences);
    decoder.handle(keyInput(2, "AG00", 0, "agent:main:first"), preferences);
    timers.advance(100);
    decoder.handle(keyInput(3, "AG01", 1, "agent:main:first"), preferences);
    decoder.handle(keyInput(4, "AG01", 0, "agent:main:first"), preferences);
    timers.advance(100);
    decoder.handle(keyInput(5, "AG00", 1, "agent:main:changed"), preferences);

    expect(gestures.map(({ action, source, sessionKey }) => [action, source, sessionKey])).toEqual([
      ["agent-open", "AG00", "agent:main:first"],
      ["agent-open", "AG01", "agent:main:first"],
      ["agent-open", "AG00", "agent:main:changed"],
    ]);
  });

  it("honors the focus-on-single-tap preference on key-down", () => {
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture));
    const preferences = defaultMicroPreferences();
    preferences.focusSingleTap = true;

    decoder.handle(keyInput(1, "AG02", 1, "agent:main:work"), preferences);

    expect(gestures).toEqual([
      {
        sequence: 1,
        action: "agent-focus",
        sessionKey: "agent:main:work",
        source: "AG02",
        agentTap: "single",
      },
    ]);
  });

  it("stops a held microphone at release and preserves the key-down target", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "ACT10", 1, "agent:main:first"), preferences);
    timers.advance(350);
    decoder.handle(keyInput(2, "ACT10", 0, "agent:main:changed"), preferences);

    expect(
      gestures.map(({ sequence, action, sessionKey, phase }) => [
        sequence,
        action,
        sessionKey,
        phase,
      ]),
    ).toEqual([
      [1, "microphone-start", "agent:main:first", "down"],
      [2, "microphone-stop", "agent:main:first", "up"],
    ]);
  });

  it("latches a short microphone tap, stops on the next press, suppresses 350 ms, then rearms", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "ACT10", 1, "agent:main:first"), preferences);
    timers.advance(100);
    decoder.handle(keyInput(2, "ACT10", 0, "agent:main:release-target"), preferences);
    timers.advance(249);
    decoder.handle(keyInput(3, "ACT10", 1, "agent:main:second-press"), preferences);
    decoder.handle(keyInput(4, "ACT10", 0, "agent:main:second-release"), preferences);
    timers.advance(1_000);
    decoder.handle(keyInput(5, "ACT10", 1, "agent:main:stop-target"), preferences);
    decoder.handle(keyInput(6, "ACT10", 0, "agent:main:stop-release"), preferences);
    timers.advance(349);
    decoder.handle(keyInput(7, "ACT10", 1, "agent:main:suppressed"), preferences);
    decoder.handle(keyInput(8, "ACT10", 0, "agent:main:suppressed-release"), preferences);
    timers.advance(1);
    decoder.handle(keyInput(9, "ACT10", 1, "agent:main:rearmed"), preferences);

    expect(
      gestures.map(({ sequence, action, sessionKey }) => [sequence, action, sessionKey]),
    ).toEqual([
      [1, "microphone-start", "agent:main:first"],
      [5, "microphone-stop", "agent:main:first"],
      [9, "microphone-start", "agent:main:rearmed"],
    ]);
  });

  it("cancels a pending microphone stop on reset without replay", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "ACT10", 1, "agent:main:first"), preferences);
    timers.advance(100);
    decoder.handle(keyInput(2, "ACT10", 0, "agent:main:changed"), preferences);
    decoder.clear();
    timers.advance(1_000);

    expect(
      gestures.map(({ sequence, action, sessionKey }) => [sequence, action, sessionKey]),
    ).toEqual([[1, "microphone-start", "agent:main:first"]]);
  });

  it("holds microphone release to the original target and ignores ACT11 by default", () => {
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture));
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "ACT10", 1, "agent:main:first"), preferences);
    decoder.handle(keyInput(2, "ACT11", 1, "agent:main:first"), preferences);
    decoder.handle(keyInput(3, "ACT10", 0, "agent:main:changed"), preferences);

    expect(gestures.map(({ action, sessionKey }) => [action, sessionKey])).toEqual([
      ["microphone-start", "agent:main:first"],
    ]);
  });

  it("fires one stick action per deflection and rearms only at the center", () => {
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture));
    const preferences = defaultMicroPreferences();

    decoder.handle(radialInput(1, 0.75, 0.49, "agent:main:a"), preferences);
    decoder.handle(radialInput(2, 0.75, 0.7, "agent:main:a"), preferences);
    decoder.handle(radialInput(3, 0, 0.8, "agent:main:b"), preferences);
    decoder.handle(radialInput(4, 0, 0.1, null), preferences);
    decoder.handle(radialInput(5, 0, 0.8, "agent:main:c"), preferences);

    expect(gestures.map(({ action, sessionKey }) => [action, sessionKey])).toEqual([
      ["up", "agent:main:a"],
      ["right", "agent:main:c"],
    ]);
  });

  it("opens settings on the 500 ms encoder hold and suppresses the release click", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "ENC_CLK", 1, "agent:main:work"), preferences);
    timers.advance(500);
    decoder.handle(keyInput(2, "ENC_CLK", 0, "agent:main:changed"), preferences);

    expect(gestures).toEqual([
      { sequence: 1, action: "settings", sessionKey: "agent:main:work", source: "ENC_CLK" },
    ]);
  });

  it("clears held presses and double-tap state on cancellation", () => {
    const timers = new FakeTimers();
    const gestures: MicroGesture[] = [];
    const decoder = new MicroGestureDecoder((gesture) => gestures.push(gesture), timers.port);
    const preferences = defaultMicroPreferences();

    decoder.handle(keyInput(1, "AG01", 1, "agent:main:work"), preferences);
    decoder.handle(keyInput(2, "AG01", 0, "agent:main:work"), preferences);
    decoder.handle(keyInput(3, "ACT10", 1, "agent:main:work"), preferences);
    decoder.clear();
    timers.advance(1_000);
    decoder.handle(keyInput(4, "ACT10", 0, "agent:main:work"), preferences);
    decoder.handle(keyInput(5, "AG01", 1, "agent:main:work"), preferences);

    expect(gestures.map(({ action, agentTap }) => [action, agentTap])).toEqual([
      ["agent-open", "single"],
      ["microphone-start", undefined],
      ["agent-open", "single"],
    ]);
  });
});

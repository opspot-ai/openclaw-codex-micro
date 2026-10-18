import type { MicroInput, MicroPreferences } from "../contract.js";

export type MicroGesture = {
  sequence: number;
  action: string;
  sessionKey: string | null;
  source: string;
  phase?: "down" | "up";
  agentTap?: "single" | "double";
};

type TimerPort = {
  now: () => number;
  set: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clear: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
};

const realTimers: TimerPort = {
  now: () => Date.now(),
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (timer) => globalThis.clearTimeout(timer),
};

type Press = {
  sequence: number;
  startedAt: number;
  sessionKey: string | null;
  source: string;
  settingsTimer?: ReturnType<typeof globalThis.setTimeout>;
  settingsOpened?: boolean;
};

type LastAgentPress = {
  pressedAt: number;
  sessionKey: string | null;
};

type MicrophoneState =
  | { type: "pressed"; startedAt: number; sessionKey: string | null; source: string }
  | {
      type: "waiting";
      deadline: number;
      releaseSequence: number;
      sessionKey: string | null;
      source: string;
      timer: ReturnType<typeof globalThis.setTimeout>;
    }
  | { type: "latched"; sessionKey: string | null; source: string }
  | { type: "suppressing"; deadline: number; sessionKey: string | null; source: string };

const AGENT_KEY = /^AG0([0-5])$/u;
const ACTION_KEY = /^ACT(0[6-9]|1[0-2])$/u;
const AGENT_DOUBLE_TAP_MS = 350;
const MICROPHONE_GESTURE_MS = 350;

function agentSlot(key: string): number | null {
  const match = AGENT_KEY.exec(key);
  return match ? Number(match[1]) : null;
}

function direction(angle: number): "up" | "right" | "down" | "left" {
  if (angle >= 0.625 && angle < 0.875) {
    return "up";
  }
  if (angle >= 0.125 && angle < 0.375) {
    return "down";
  }
  if (angle >= 0.375 && angle < 0.625) {
    return "left";
  }
  return "right";
}

export class MicroGestureDecoder {
  private readonly presses = new Map<string, Press>();
  private readonly lastAgentPresses = new Map<number, LastAgentPress>();
  private readonly microphoneStates = new Map<string, MicrophoneState>();
  private radialConsumed = false;
  private radialSessionKey: string | null = null;

  constructor(
    private readonly emit: (gesture: MicroGesture) => void,
    private readonly timers: TimerPort = realTimers,
  ) {}

  handle(input: MicroInput, preferences: MicroPreferences): void {
    if (input.kind === "radial") {
      this.handleRadial(input);
      return;
    }
    const key = input.key;
    const act = input.act;
    if (!key || typeof act !== "number") {
      return;
    }

    if ((key === "ENC_CW" || key === "ENC_CC") && act === 2) {
      this.emit({
        sequence: input.sequence,
        action:
          preferences.encoderMode === "reasoning"
            ? key === "ENC_CW"
              ? "reason-decrease"
              : "reason-increase"
            : key === "ENC_CW"
              ? "navigate-previous"
              : "navigate-next",
        sessionKey: input.sessionKey,
        source: key,
      });
      return;
    }

    if (act === 1) {
      this.handleDown(input, key, preferences);
    } else if (act === 0) {
      this.handleUp(input, key, preferences);
    }
  }

  clear(): void {
    for (const press of this.presses.values()) {
      if (press.settingsTimer) {
        this.timers.clear(press.settingsTimer);
      }
    }
    for (const state of this.microphoneStates.values()) {
      if (state.type === "waiting") {
        this.timers.clear(state.timer);
      }
    }
    this.presses.clear();
    this.lastAgentPresses.clear();
    this.microphoneStates.clear();
    this.radialConsumed = false;
    this.radialSessionKey = null;
  }

  private handleDown(input: MicroInput, key: string, preferences: MicroPreferences): void {
    if (this.presses.has(key)) {
      return;
    }
    const press: Press = {
      sequence: input.sequence,
      startedAt: this.timers.now(),
      sessionKey: input.sessionKey,
      source: key,
    };
    this.presses.set(key, press);

    if (key === "ENC_CLK") {
      press.settingsTimer = this.timers.set(() => {
        if (this.presses.get(key) !== press) {
          return;
        }
        press.settingsOpened = true;
        this.emit({
          sequence: press.sequence,
          action: "settings",
          sessionKey: press.sessionKey,
          source: key,
        });
      }, 500);
      return;
    }

    const slot = agentSlot(key);
    if (slot !== null) {
      this.handleAgentDown(input, slot, press, preferences.focusSingleTap);
      return;
    }
    if (key === "ACT11" && !preferences.separateMicrophoneKeys) {
      return;
    }
    if (!ACTION_KEY.test(key)) {
      return;
    }

    const binding = preferences.bindings[key];
    const action = binding?.type === "command" ? binding.value : (binding?.type ?? "none");
    if (action === "microphone" && key === "ACT11" && preferences.separateMicrophoneKeys) {
      this.emit({
        sequence: input.sequence,
        action: "microphone-toggle-dictation",
        sessionKey: press.sessionKey,
        source: key,
      });
      return;
    }
    if (action === "microphone" && preferences.microphoneMode === "push-to-talk") {
      this.handleMicrophoneDown(input, press);
      return;
    }
    if (action !== "microphone" || preferences.microphoneMode === "toggle-dictation") {
      this.emit({ sequence: input.sequence, action, sessionKey: press.sessionKey, source: key });
    }
  }

  private handleUp(input: MicroInput, key: string, preferences: MicroPreferences): void {
    const press = this.presses.get(key);
    if (!press) {
      return;
    }
    this.presses.delete(key);
    if (press.settingsTimer) {
      this.timers.clear(press.settingsTimer);
    }

    if (agentSlot(key) !== null) {
      return;
    }

    if (key === "ENC_CLK") {
      if (press.settingsOpened || this.timers.now() - press.startedAt >= 500) {
        if (!press.settingsOpened) {
          this.emit({
            sequence: press.sequence,
            action: "settings",
            sessionKey: press.sessionKey,
            source: key,
          });
        }
        return;
      }
      this.emit({
        sequence: input.sequence,
        action: "select",
        sessionKey: press.sessionKey,
        source: key,
      });
      return;
    }

    if (key === "ACT11" && !preferences.separateMicrophoneKeys) {
      return;
    }
    const binding = preferences.bindings[key];
    const action = binding?.type === "command" ? binding.value : (binding?.type ?? "none");
    if (
      action === "microphone" &&
      key === "ACT10" &&
      preferences.microphoneMode === "push-to-talk"
    ) {
      this.handleMicrophoneUp(input, press);
    }
  }

  private handleAgentDown(
    input: MicroInput,
    slot: number,
    press: Press,
    focusSingleTap: boolean,
  ): void {
    const now = this.timers.now();
    const previous = this.lastAgentPresses.get(slot);
    const isDoubleTap =
      previous !== undefined &&
      previous.sessionKey === press.sessionKey &&
      now - previous.pressedAt <= AGENT_DOUBLE_TAP_MS;
    if (isDoubleTap) {
      this.lastAgentPresses.delete(slot);
      this.emit({
        sequence: input.sequence,
        action: "agent-focus",
        sessionKey: press.sessionKey,
        source: press.source,
        agentTap: "double",
      });
      return;
    }

    this.lastAgentPresses.set(slot, { pressedAt: now, sessionKey: press.sessionKey });
    this.emit({
      sequence: input.sequence,
      action: focusSingleTap ? "agent-focus" : "agent-open",
      sessionKey: press.sessionKey,
      source: press.source,
      agentTap: "single",
    });
  }

  private handleMicrophoneDown(input: MicroInput, press: Press): void {
    const key = press.source;
    const now = this.timers.now();
    const state = this.microphoneStates.get(key);
    if (state?.type === "waiting") {
      if (now < state.deadline) {
        this.timers.clear(state.timer);
        this.microphoneStates.set(key, {
          type: "latched",
          sessionKey: state.sessionKey,
          source: state.source,
        });
        return;
      }
      this.finishWaitingMicrophone(key, state);
    }
    if (state?.type === "latched") {
      this.microphoneStates.set(key, {
        type: "suppressing",
        deadline: now + MICROPHONE_GESTURE_MS,
        sessionKey: state.sessionKey,
        source: state.source,
      });
      this.emit({
        sequence: input.sequence,
        action: "microphone-stop",
        sessionKey: state.sessionKey,
        source: state.source,
        phase: "up",
      });
      return;
    }
    if (state?.type === "suppressing" && now < state.deadline) {
      return;
    }

    this.microphoneStates.set(key, {
      type: "pressed",
      startedAt: now,
      sessionKey: press.sessionKey,
      source: key,
    });
    this.emit({
      sequence: input.sequence,
      action: "microphone-start",
      sessionKey: press.sessionKey,
      source: key,
      phase: "down",
    });
  }

  private handleMicrophoneUp(input: MicroInput, press: Press): void {
    const key = press.source;
    const state = this.microphoneStates.get(key);
    if (!state || state.type !== "pressed") {
      return;
    }
    const now = this.timers.now();
    if (now - state.startedAt >= MICROPHONE_GESTURE_MS) {
      this.microphoneStates.delete(key);
      this.emit({
        sequence: input.sequence,
        action: "microphone-stop",
        sessionKey: state.sessionKey,
        source: state.source,
        phase: "up",
      });
      return;
    }

    let waiting: Extract<MicrophoneState, { type: "waiting" }> | null = null;
    const timer = this.timers.set(
      () => {
        if (waiting) {
          this.finishWaitingMicrophone(key, waiting);
        }
      },
      Math.max(0, state.startedAt + MICROPHONE_GESTURE_MS - now),
    );
    waiting = {
      type: "waiting" as const,
      deadline: state.startedAt + MICROPHONE_GESTURE_MS,
      releaseSequence: input.sequence,
      sessionKey: state.sessionKey,
      source: state.source,
      timer,
    };
    this.microphoneStates.set(key, waiting);
  }

  private finishWaitingMicrophone(
    key: string,
    waiting: Extract<MicrophoneState, { type: "waiting" }>,
  ): void {
    if (this.microphoneStates.get(key) !== waiting) {
      return;
    }
    this.timers.clear(waiting.timer);
    this.microphoneStates.delete(key);
    this.emit({
      sequence: waiting.releaseSequence,
      action: "microphone-stop",
      sessionKey: waiting.sessionKey,
      source: waiting.source,
      phase: "up",
    });
  }

  private handleRadial(input: MicroInput): void {
    const distance = input.distance;
    const angle = input.angle;
    if (typeof distance !== "number" || !Number.isFinite(distance)) {
      return;
    }
    if (distance <= 0.1) {
      this.radialConsumed = false;
      this.radialSessionKey = null;
      return;
    }
    if (distance < 0.5 || typeof angle !== "number" || !Number.isFinite(angle)) {
      return;
    }
    const next = direction(angle);
    if (this.radialConsumed) {
      return;
    }
    this.radialConsumed = true;
    this.radialSessionKey = input.sessionKey;
    this.emit({
      sequence: input.sequence,
      action: next,
      sessionKey: this.radialSessionKey,
      source: "radial",
    });
  }
}

export function resolveAgentSlot(key: string): number | null {
  return agentSlot(key);
}

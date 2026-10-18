import type { ControlUiHost, ControlUiSurfaceProps } from "openclaw/plugin-sdk/control-ui";

type ComposerProps = ControlUiSurfaceProps["composer"];
type Composer = { props: ComposerProps; container: HTMLElement; token: object };
type DictationFinish = NonNullable<ComposerProps["finishDictation"]>;
type HeldPushToTalk = {
  sessionKey: string;
  finish: DictationFinish;
};
export type MicroVoiceState = "idle" | "recording" | "processing" | "completed";

export type MicroVoiceDependencies = {
  host: ControlUiHost;
  composer: () => Composer | null;
  assertWrite: (generation: number) => void;
  onStateChange: (state: MicroVoiceState) => void;
  onError: (error: Error) => void;
};

function sameKey(host: ControlUiHost, left: string, right: string): boolean {
  return host.sessions.normalizeKey(left) === host.sessions.normalizeKey(right);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class MicroVoiceController {
  private ptt: HeldPushToTalk | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: MicroVoiceState = "idle";

  constructor(private readonly dependencies: MicroVoiceDependencies) {}

  get state(): MicroVoiceState {
    return this.currentState;
  }

  toggleMicrophone(
    sessionKey: string | null,
    _forceDictation: boolean,
    generation: number,
  ): string {
    this.dependencies.assertWrite(generation);
    if (!sessionKey) {
      throw new Error("No conversation was captured for this microphone action.");
    }
    const composer = this.requireComposer(sessionKey);
    const start = composer.props.startDictation;
    const finish = composer.props.finishDictation;
    if (!start || !finish) {
      throw new Error("Native dictation is unavailable for this captured composer.");
    }
    if (
      this.currentState === "processing" ||
      composer.container.querySelector(".agent-chat__dictation-status--finalizing")
    ) {
      throw new Error("Native dictation is still finalizing for this composer.");
    }
    const dictationActive =
      this.currentState === "recording" ||
      composer.container.querySelector(".chat-send-btn--dictating") !== null;
    if (dictationActive) {
      if (this.ptt && sameKey(this.dependencies.host, this.ptt.sessionKey, sessionKey)) {
        const held = this.ptt;
        this.ptt = null;
        this.requestFinish(held.finish);
        return "Requested the captured native dictation to stop.";
      }
      this.requestFinish(finish);
      return "Requested the captured native dictation to stop.";
    }
    if (!start()) {
      throw new Error("Native dictation could not start in the captured composer.");
    }
    this.readState();
    return "Requested native dictation from the captured composer.";
  }

  startPushToTalk(sessionKey: string | null, generation: number): string {
    this.dependencies.assertWrite(generation);
    if (!sessionKey) {
      throw new Error("No conversation was captured for this microphone press.");
    }
    const composer = this.requireComposer(sessionKey);
    if (this.ptt) {
      return "Push-to-talk is already held for the captured conversation.";
    }
    const start = composer.props.startDictation;
    const finish = composer.props.finishDictation;
    if (!start || !finish) {
      throw new Error("Native push-to-talk dictation is unavailable for this composer.");
    }

    const held: HeldPushToTalk = {
      sessionKey,
      finish,
    };
    this.ptt = held;
    if (!start()) {
      this.ptt = null;
      throw new Error("Native push-to-talk dictation could not start in this composer.");
    }
    this.readState();
    return "Requested push-to-talk dictation from the captured native composer.";
  }

  stopPushToTalk(sessionKey: string | null, generation: number): string {
    this.dependencies.assertWrite(generation);
    const held = this.ptt;
    if (!held) {
      return "No push-to-talk dictation press is active.";
    }
    if (!sessionKey || !sameKey(this.dependencies.host, held.sessionKey, sessionKey)) {
      throw new Error(
        "This release does not match the conversation captured when dictation started.",
      );
    }
    this.ptt = null;
    this.requestFinish(held.finish);
    return "Requested stop for the captured native push-to-talk dictation.";
  }

  readState(): void {
    const composer = this.dependencies.composer();
    const container = composer?.container;
    if (!container) {
      this.clearCompletion();
      this.setState("idle");
      return;
    }
    const processing = container.querySelector(".agent-chat__dictation-status--finalizing");
    const recording = container.querySelector(".chat-send-btn--dictating");
    if (processing) {
      this.clearCompletion();
      this.setState("processing");
      return;
    }
    if (recording) {
      this.clearCompletion();
      this.setState("recording");
      return;
    }
    if (this.currentState === "recording" || this.currentState === "processing") {
      this.setState("completed");
      this.completionTimer = globalThis.setTimeout(() => {
        this.completionTimer = null;
        this.readStateAfterCompletion();
      }, 1_000);
      return;
    }
    if (this.currentState !== "completed") {
      this.setState("idle");
    }
  }

  resetForReconnect(): void {
    this.cancelForComposerChange();
  }

  cancelForComposerChange(): void {
    const held = this.ptt;
    if (held) {
      this.ptt = null;
      // The captured native callback stops its own controller even after the
      // Gateway disconnects or the visible composer moves to another session.
      this.requestFinish(held.finish);
    }
    this.clearCompletion();
    this.setState("idle");
  }

  dispose(): void {
    this.cancelForComposerChange();
  }

  private requireComposer(sessionKey: string | null): Composer {
    if (!sessionKey) {
      throw new Error("No conversation was captured for this microphone action.");
    }
    const composer = this.dependencies.composer();
    if (!composer || !sameKey(this.dependencies.host, composer.props.sessionKey, sessionKey)) {
      throw new Error(
        "Open the captured conversation's native composer before using its microphone.",
      );
    }
    return composer;
  }

  private requestFinish(finish: DictationFinish): void {
    try {
      void finish().catch((error: unknown) => this.dependencies.onError(asError(error)));
    } catch (error) {
      this.dependencies.onError(asError(error));
    }
  }

  private readStateAfterCompletion(): void {
    const container = this.dependencies.composer()?.container;
    if (!container) {
      this.setState("idle");
    } else if (container.querySelector(".agent-chat__dictation-status--finalizing")) {
      this.setState("processing");
    } else if (container.querySelector(".chat-send-btn--dictating")) {
      this.setState("recording");
    } else {
      this.setState("idle");
    }
  }

  private clearCompletion(): void {
    if (this.completionTimer) {
      globalThis.clearTimeout(this.completionTimer);
    }
    this.completionTimer = null;
  }

  private setState(next: MicroVoiceState): void {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.dependencies.onStateChange(next);
  }
}

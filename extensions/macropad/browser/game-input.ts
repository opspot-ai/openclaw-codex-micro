import type { MicroInput } from "../contract.js";
import { CircularGameActivation } from "./games.js";
import type { MicroGamesSurface } from "./games.js";
import type { MicroGesture } from "./gestures.js";

export type MicroGameAttachment = {
  start(): void;
  exit(): void;
  detach(): void;
};

type GameInputContext = {
  disposed: boolean;
  focused: boolean;
  visible: boolean;
  connected: boolean;
  canWrite: boolean;
  deviceConnected: boolean;
  composer: { token: object; sessionKey: string } | null;
  sameSession(left: string, right: string): boolean;
};

type GameInputContextSource = {
  disposed: boolean;
  focused: boolean;
  device: { connected: boolean } | null;
  composer: { token: object; props: { sessionKey: string } } | null;
  host: {
    connection: { connected: boolean; canWrite: boolean };
    sessions: { normalizeKey(key: string): string };
  };
};

export class MicroGameInputRouter {
  private readonly activation = new CircularGameActivation();
  private surface: MicroGamesSurface | null = null;
  private surfaceToken: object | null = null;
  private gameMode = false;
  private currentEpoch = 0;
  private readonly heldKeys = new Set<string>();
  private readonly suppressedKeys = new Set<string>();
  private quarantined = false;
  private neutralObserved = false;
  private inputTail: Promise<void> = Promise.resolve();
  private lastSequence = 0;

  constructor(private readonly clearDecoder: () => void) {}

  get epoch(): number {
    return this.currentEpoch;
  }

  acceptSequence(sequence: number): boolean {
    if (sequence <= this.lastSequence) {
      return false;
    }
    this.lastSequence = sequence;
    return true;
  }

  resetSequence(): void {
    this.lastSequence = 0;
  }

  focusChanged(focused: boolean): void {
    if (!focused) {
      this.cancel();
    }
  }

  deviceChanged(wasConnected: boolean, connected: boolean): void {
    if (wasConnected && !connected) {
      this.cancel();
    }
  }

  attach(
    surface: MicroGamesSurface,
    token: object,
    composerToken: () => object | null,
  ): MicroGameAttachment {
    this.cancel();
    this.surface = surface;
    this.surfaceToken = token;
    return {
      start: () => this.enter(token, composerToken()),
      exit: () => this.exit(token),
      detach: () => {
        if (this.surfaceToken !== token) {
          return;
        }
        this.cancel();
        this.surface = null;
        this.surfaceToken = null;
      },
    };
  }

  enter(token: object, composerToken: object | null): void {
    if (this.surfaceToken !== token || composerToken !== token || this.gameMode) {
      return;
    }
    this.gameMode = true;
    this.reset(false);
  }

  exit(token: object): void {
    if (this.surfaceToken !== token || !this.gameMode) {
      return;
    }
    this.gameMode = false;
    this.reset(true);
  }

  dispose(): void {
    this.cancel();
    this.surface?.dispose();
    this.surface = null;
    this.surfaceToken = null;
  }

  cancel(): void {
    const wasActive = this.gameMode;
    const shouldQuarantine = wasActive || this.activation.pending || this.quarantined;
    this.gameMode = false;
    if (shouldQuarantine) {
      this.reset(true);
    } else {
      this.activation.reset();
    }
    if (wasActive && this.surface) {
      this.surface.stop(false);
    }
  }

  enqueueGesture(
    gesture: MicroGesture,
    generation: number,
    callbacks: {
      isCurrent(generation: number): boolean;
      execute(gesture: MicroGesture, generation: number): Promise<string>;
      sendReceipt(
        sequence: number,
        action: string,
        ok: boolean,
        message: string,
        generation: number,
      ): Promise<void>;
      onError(error: unknown): void;
    },
  ): void {
    const epoch = this.currentEpoch;
    this.inputTail = this.inputTail
      .then(async () => {
        if (!callbacks.isCurrent(generation) || epoch !== this.currentEpoch) {
          return;
        }
        let ok = true;
        let message: string;
        try {
          message = await callbacks.execute(gesture, generation);
        } catch (error) {
          ok = false;
          message = error instanceof Error ? error.message : String(error);
        }
        if (epoch !== this.currentEpoch) {
          return;
        }
        await callbacks.sendReceipt(gesture.sequence, gesture.action, ok, message, generation);
      })
      .catch((error: unknown) => callbacks.onError(error));
  }

  receive(
    input: MicroInput,
    source: GameInputContextSource,
    dispatchOrdinary: (input: MicroInput) => void,
  ): void {
    const context: GameInputContext = {
      disposed: source.disposed,
      focused: source.focused,
      visible: document.visibilityState !== "hidden",
      connected: source.host.connection.connected,
      canWrite: source.host.connection.canWrite,
      deviceConnected: Boolean(source.device?.connected),
      composer: source.composer
        ? { token: source.composer.token, sessionKey: source.composer.props.sessionKey }
        : null,
      sameSession: (left, right) =>
        source.host.sessions.normalizeKey(left) === source.host.sessions.normalizeKey(right),
    };
    const { composer, disposed, focused, visible } = context;
    const sessionMatches =
      !input.sessionKey || !composer || context.sameSession(composer.sessionKey, input.sessionKey);
    const eligible = Boolean(
      !disposed &&
      focused &&
      visible &&
      context.connected &&
      context.canWrite &&
      context.deviceConnected &&
      composer &&
      this.surface !== null &&
      this.surfaceToken === composer.token &&
      sessionMatches,
    );
    if (this.gameMode) {
      if (!eligible) {
        this.cancel();
        return;
      }
      if (input.kind === "key" && input.key) {
        if (input.act === 1) {
          this.heldKeys.add(input.key);
        } else if (input.act === 0) {
          this.heldKeys.delete(input.key);
        }
      }
      this.surface?.handleInput(input);
      return;
    }
    if (this.activation.pending && !eligible) {
      this.cancel();
      this.consumeQuarantined(input, eligible, focused, visible, dispatchOrdinary);
      return;
    }
    if (this.quarantined) {
      this.consumeQuarantined(input, eligible, focused, visible, dispatchOrdinary);
      return;
    }
    if (this.activation.pending && input.kind !== "radial") {
      const replay = this.activation.reset();
      if (replay) {
        dispatchOrdinary(replay);
      }
    }
    if (input.kind === "radial" && eligible) {
      const activation = this.activation.handle(input, Date.now());
      if ("replay" in activation && activation.replay) {
        dispatchOrdinary(activation.replay);
      }
      if (activation.kind === "pending") {
        return;
      }
      if (activation.kind === "activated") {
        this.surface?.startRandom();
        return;
      }
      if (this.activation.pending) {
        return;
      }
      dispatchOrdinary(input);
      return;
    }
    dispatchOrdinary(input);
  }

  private reset(suppressUntilCenter: boolean): void {
    this.activation.reset();
    this.suppressedKeys.clear();
    if (suppressUntilCenter) {
      for (const key of this.heldKeys) {
        this.suppressedKeys.add(key);
      }
    }
    this.heldKeys.clear();
    this.quarantined = suppressUntilCenter;
    this.neutralObserved = false;
    this.currentEpoch += 1;
    this.clearDecoder();
  }

  private consumeQuarantined(
    input: MicroInput,
    eligible: boolean,
    focused: boolean,
    visible: boolean,
    dispatchOrdinary: (input: MicroInput) => void,
  ): void {
    if (input.kind === "key") {
      if (input.key && input.act === 0) {
        this.suppressedKeys.delete(input.key);
      } else if (input.key && input.act === 1 && focused && visible && eligible) {
        this.suppressedKeys.add(input.key);
      }
      if (
        this.neutralObserved &&
        this.suppressedKeys.size === 0 &&
        focused &&
        visible &&
        eligible
      ) {
        this.quarantined = false;
      }
      return;
    }
    if (!focused || !visible || !eligible) {
      return;
    }
    if (typeof input.distance === "number" && input.distance <= 0.1) {
      this.neutralObserved = true;
      if (this.suppressedKeys.size === 0) {
        this.quarantined = false;
        dispatchOrdinary(input);
      }
    }
  }
}

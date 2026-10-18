import { defaultMicroPreferences, type MicroPreferences } from "../contract.js";

type MicroPreferenceStoreDependencies = {
  connected: () => boolean;
  canWrite: () => boolean;
  generation: () => number;
  assertWrite: (generation: number) => void;
  save: (preferences: MicroPreferences) => Promise<MicroPreferences>;
  onChange: () => void;
  onError: (error: unknown) => void;
  currentError: () => string | null;
};

export class MicroPreferenceStore {
  private value = defaultMicroPreferences();
  private loaded = false;
  private revision = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: MicroPreferenceStoreDependencies) {}

  get preferences(): MicroPreferences {
    return this.value;
  }

  get ready(): boolean {
    return this.loaded;
  }

  acceptLoaded(preferences: MicroPreferences): void {
    this.revision += 1;
    this.value = preferences;
    this.loaded = true;
    this.dependencies.onChange();
  }

  invalidate(): void {
    this.revision += 1;
    this.loaded = false;
  }

  async update(preferences: MicroPreferences): Promise<boolean> {
    if (!this.loaded) {
      this.reportError(
        new Error("Saved Codex Micro preferences are still loading; settings were not changed."),
      );
      return false;
    }
    if (!this.dependencies.connected() || !this.dependencies.canWrite()) {
      this.reportError(
        new Error("Codex Micro settings need an active Control UI connection with write access."),
      );
      return false;
    }

    const previous = this.value;
    const revision = ++this.revision;
    const generation = this.dependencies.generation();
    this.value = preferences;
    this.dependencies.onError(null);
    this.dependencies.onChange();

    const write = this.writes.then(() => {
      this.dependencies.assertWrite(generation);
      if (revision !== this.revision) {
        return null;
      }
      return this.dependencies.save(preferences);
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    try {
      const committed = await write;
      this.dependencies.assertWrite(generation);
      if (committed && revision === this.revision) {
        this.value = committed;
      }
      this.dependencies.onChange();
      return committed !== null;
    } catch (error) {
      if (revision === this.revision) {
        this.value = previous;
        this.dependencies.onError(error);
      }
      this.dependencies.onChange();
      return false;
    }
  }

  async assignSession(
    slot: number,
    sessionKey: string,
    generation: number,
  ): Promise<
    { status: "assigned" } | { status: "changed" } | { status: "failed"; message: string }
  > {
    try {
      this.dependencies.assertWrite(generation);
    } catch (error) {
      return { status: "failed", message: this.message(error) };
    }
    const current = this.value;
    if (current.agentSource !== "custom" || current.customSessionKeys[slot] !== null) {
      return { status: "changed" };
    }
    const next: MicroPreferences = {
      ...current,
      customSessionKeys: [...current.customSessionKeys],
    };
    next.customSessionKeys[slot] = sessionKey;
    const saved = await this.update(next);
    try {
      this.dependencies.assertWrite(generation);
    } catch (error) {
      return { status: "failed", message: this.message(error) };
    }
    const latest = this.value;
    if (latest.agentSource === "custom" && latest.customSessionKeys[slot] === sessionKey) {
      return { status: "assigned" };
    }
    if (latest.agentSource !== "custom" || latest.customSessionKeys[slot] !== null) {
      return { status: "changed" };
    }
    return saved
      ? { status: "changed" }
      : {
          status: "failed",
          message: this.dependencies.currentError() ?? "The custom slot preference was not saved.",
        };
  }

  private reportError(error: unknown): void {
    this.dependencies.onError(error);
    this.dependencies.onChange();
  }

  private message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 512);
  }
}

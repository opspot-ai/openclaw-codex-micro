// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicroBrowserController } from "./controller.js";
import macropadPlugin from "./index.js";
import { createHost, sessions, waitForPreferences } from "./test/controller.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Codex Micro native Control UI surfaces", () => {
  it("keeps both native surfaces mounted inside the replacements", async () => {
    const harness = createHost();
    const cleanup = await macropadPlugin.activate(harness.host);
    expect(typeof cleanup).toBe("function");
    const disposePlugin = cleanup as () => void;
    const mountDefault = vi.fn((container: HTMLElement) => {
      const native = document.createElement("div");
      native.className = "native-default";
      native.textContent = "Native Control UI surface";
      container.append(native);
      return vi.fn();
    });
    const common = {
      host: harness.host,
      signal: harness.host.signal,
      presented: true,
      mountDefault,
    };

    const sidebarContainer = document.createElement("div");
    const sidebar = harness.replacements.get("session-list")!;
    const sidebarContext = { ...common, props: { sessions } };
    const sidebarView = sidebar.mount(sidebarContainer, sidebarContext);
    expect(sidebarContainer.querySelector(".native-default")?.textContent).toBe(
      "Native Control UI surface",
    );

    const composerContainer = document.createElement("div");
    const composer = harness.replacements.get("composer")!;
    const composerProps = {
      sessionKey: "agent:main:first",
      agentId: "main",
      draft: "",
      canSend: false,
      sending: false,
      disabledReason: null,
      setDraft: vi.fn(),
      send: vi.fn(async () => false),
      abort: vi.fn(),
    };
    const composerContext = { ...common, props: composerProps };
    const composerView = composer.mount(composerContainer, composerContext);
    expect(composerContainer.querySelector(".native-default")?.textContent).toBe(
      "Native Control UI surface",
    );
    expect(composerContainer.textContent).not.toContain("agent:main:first");

    sidebarView.update?.({ ...sidebarContext, props: { sessions: [...sessions] } });
    composerView.update?.({ ...composerContext, props: { ...composerProps, draft: "updated" } });
    expect(sidebarContainer.querySelector(".native-default")).not.toBeNull();
    expect(composerContainer.querySelector(".native-default")).not.toBeNull();
    expect(mountDefault).toHaveBeenCalledTimes(2);

    sidebarView.dispose?.();
    composerView.dispose?.();
    disposePlugin();
  });

  it("shows native dictation processing and its one-second completion state", async () => {
    vi.useFakeTimers();
    const harness = createHost();
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    const container = document.createElement("div");
    const active = document.createElement("button");
    active.className = "chat-send-btn--dictating";
    const finalizing = document.createElement("div");
    finalizing.className = "agent-chat__dictation-status--finalizing";
    container.append(active, finalizing);
    controller.setComposer(
      {
        sessionKey: "agent:main:first",
        agentId: "main",
        draft: "",
        canSend: false,
        sending: false,
        disabledReason: null,
        setDraft: vi.fn(),
        send: vi.fn(async () => false),
      } as never,
      container,
      {},
    );
    await harness.waitForUiSyncState("processing");

    expect(harness.latestUiSyncVoiceState()).toBe("processing");
    let syncCount = harness.uiSyncCount();
    finalizing.remove();
    await harness.waitForUiSyncState("recording", syncCount);
    expect(harness.latestUiSyncVoiceState()).toBe("recording");
    syncCount = harness.uiSyncCount();
    active.remove();
    await harness.waitForUiSyncState("completed", syncCount);
    expect(harness.latestUiSyncVoiceState()).toBe("completed");
    syncCount = harness.uiSyncCount();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.latestUiSyncVoiceState()).toBe("completed");
    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForUiSyncState("idle", syncCount);
    expect(harness.latestUiSyncVoiceState()).toBe("idle");
    controller.dispose();
  });

  it("does not report realtime Talk as native dictation", async () => {
    const harness = createHost();
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    const container = document.createElement("div");
    const talk = document.createElement("button");
    talk.className = "chat-send-btn--voice-live";
    container.append(talk);
    controller.setComposer(
      {
        sessionKey: "agent:main:first",
        agentId: "main",
        draft: "",
        canSend: false,
        sending: false,
        disabledReason: null,
        setDraft: vi.fn(),
        send: vi.fn(async () => false),
      } as never,
      container,
      {},
    );
    await harness.waitForUiSyncState("idle");

    expect(harness.latestUiSyncVoiceState()).toBe("idle");
    controller.dispose();
  });
});

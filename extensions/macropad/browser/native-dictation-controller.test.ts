// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMicroPreferences } from "../contract.js";
import { MicroBrowserController } from "./controller.js";
import { createHost, waitForPreferences } from "./test/controller.test-support.js";

function composerProps(startDictation: () => boolean, finishDictation: () => Promise<boolean>) {
  return {
    sessionKey: "agent:main:first",
    agentId: "main",
    draft: "",
    canSend: true,
    sending: false,
    disabledReason: null,
    setDraft: vi.fn(),
    send: vi.fn(async () => false),
    startDictation,
    finishDictation,
  } as never;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Codex Micro native dictation routing", () => {
  it("fails closed without a captured conversation before starting native dictation", async () => {
    const preferences = defaultMicroPreferences();
    preferences.microphoneMode = "toggle-dictation";
    const harness = createHost({ preferences });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    const startDictation = vi.fn(() => true);
    const finishDictation = vi.fn(async () => true);
    const container = document.createElement("div");
    controller.setComposer(composerProps(startDictation, finishDictation), container, {});

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT10",
      act: 1,
      sessionKey: null,
    });
    await harness.waitForReceiptCount(1);

    expect(startDictation).not.toHaveBeenCalled();
    expect(finishDictation).not.toHaveBeenCalled();
    expect(controller.snapshot().error).toBe(
      "No conversation was captured for this microphone action.",
    );
    controller.dispose();
  });

  it("uses the captured native callbacks and stops the old composer across reconnect", async () => {
    const harness = createHost({ generation: 1 });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    let buttonClicks = 0;
    const active = document.createElement("button");
    active.className = "chat-send-btn--voice";
    active.addEventListener("click", () => buttonClicks++);
    const container = document.createElement("div");
    container.append(active);
    const startDictation = vi.fn(() => {
      active.className = "chat-send-btn--dictating";
      return true;
    });
    const finishDictation = vi.fn(async () => {
      active.className = "chat-send-btn--voice";
      return true;
    });
    const originalToken = {};
    controller.setComposer(
      composerProps(startDictation, finishDictation),
      container,
      originalToken,
    );
    const press = (sequence: number, act: 0 | 1 = 1) =>
      harness.emitInput({
        clientId: controller.clientId,
        sequence,
        kind: "key",
        key: "ACT10",
        act,
        sessionKey: "agent:main:first",
      });

    press(1);
    await harness.waitForReceiptCount(1);
    expect(startDictation).toHaveBeenCalledOnce();
    expect(buttonClicks).toBe(0);

    harness.connection.connected = false;
    harness.notify();
    expect(finishDictation).toHaveBeenCalledOnce();
    expect(active.classList.contains("chat-send-btn--dictating")).toBe(false);
    harness.connection.connected = true;
    harness.connection.generation = 2;
    harness.notify();
    await waitForPreferences(controller);
    vi.useFakeTimers();

    const delayed = document.createElement("button");
    delayed.className = "chat-send-btn--voice";
    const nextContainer = document.createElement("div");
    nextContainer.append(delayed);
    const nextStart = vi.fn(() => {
      delayed.className = "chat-send-btn--dictating";
      return true;
    });
    const nextFinish = vi.fn(async () => {
      delayed.className = "chat-send-btn--voice";
      return true;
    });
    const nextToken = {};
    controller.setComposer(composerProps(nextStart, nextFinish), nextContainer, nextToken);
    press(1);
    await harness.waitForReceiptCount(2);
    await vi.advanceTimersByTimeAsync(350);
    press(2, 0);
    await harness.waitForReceiptCount(3);
    expect(nextFinish).toHaveBeenCalledOnce();
    press(3);
    await harness.waitForReceiptCount(4);
    controller.setComposer(null, null, nextToken);

    const replacementStart = vi.fn(() => true);
    const replacementFinish = vi.fn(async () => true);
    const replacement = document.createElement("div");
    controller.setComposer(composerProps(replacementStart, replacementFinish), replacement, {});
    expect(nextStart).toHaveBeenCalledTimes(2);
    expect(nextFinish).toHaveBeenCalledTimes(2);
    expect(replacementStart).not.toHaveBeenCalled();
    expect(replacementFinish).not.toHaveBeenCalled();
    expect(buttonClicks).toBe(0);
    controller.dispose();
  });

  it("toggles native dictation without clicking Talk or Send controls", async () => {
    const preferences = defaultMicroPreferences();
    preferences.microphoneMode = "toggle-dictation";
    const harness = createHost({ preferences });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    let buttonClicks = 0;
    const button = document.createElement("button");
    button.className = "chat-send-btn--voice";
    button.addEventListener("click", () => buttonClicks++);
    const container = document.createElement("div");
    container.append(button);
    const startDictation = vi.fn(() => {
      button.className = "chat-send-btn--dictating";
      return true;
    });
    const finishDictation = vi.fn(async () => {
      button.className = "chat-send-btn--voice";
      return true;
    });
    controller.setComposer(composerProps(startDictation, finishDictation), container, {});
    const input = (sequence: number, act: 0 | 1) =>
      harness.emitInput({
        clientId: controller.clientId,
        sequence,
        kind: "key",
        key: "ACT10",
        act,
        sessionKey: "agent:main:first",
      });

    input(1, 1);
    await harness.waitForReceiptCount(1);
    input(2, 0);
    input(3, 1);
    await harness.waitForReceiptCount(2);

    expect(startDictation).toHaveBeenCalledOnce();
    expect(finishDictation).toHaveBeenCalledOnce();
    expect(buttonClicks).toBe(0);
    controller.dispose();
  });
});

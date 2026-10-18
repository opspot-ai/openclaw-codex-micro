import { afterEach, describe, expect, it, vi } from "vitest";
import type { MicroInput } from "../contract.js";
import { MicroBrowserController } from "./controller.js";
import type { MicroGamesSurface } from "./games.js";
import { createHost, flushActions, waitForPreferences } from "./test/controller.test-support.js";

describe("Codex Micro game input controller", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("captures the launcher circle and game-era keys without Plan or stale-key actions", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const harness = createHost({ deviceConnected: true });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    await flushActions();

    const token = {};
    let active = false;
    let starts = 0;
    const handleInput = vi.fn();
    const stop = vi.fn(() => {
      active = false;
    });
    const setDraft = vi.fn();
    const surface: MicroGamesSurface = {
      get active() {
        return active;
      },
      startRandom() {
        starts += 1;
        active = true;
        gameAttachment.start();
      },
      handleInput,
      stop,
      dispose: vi.fn(),
    };
    const gameAttachment = controller.attachGames(surface, token);
    controller.setComposer(
      {
        sessionKey: "agent:main:first",
        agentId: "main",
        draft: "Keep this draft",
        canSend: true,
        sending: false,
        disabledReason: null,
        setDraft,
        send: vi.fn(async () => false),
      } as never,
      document.createElement("div"),
      token,
    );
    expect(controller.snapshot().device?.connected).toBe(true);

    let sequence = 1;
    const emit = (kind: "radial" | "key", fields: Partial<MicroInput> = {}) => {
      harness.emitInput({
        clientId: controller.clientId,
        sequence: sequence++,
        kind,
        sessionKey: "agent:main:first",
        ...fields,
      } as Omit<MicroInput, "connectionId">);
    };
    emit("radial", { angle: 0, distance: 0 });
    for (let index = 0; index <= 73; index += 1) {
      emit("radial", { angle: (0.75 + index * 0.025) % 1, distance: 0.8 });
    }

    expect(starts).toBe(1);
    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toEqual([]);
    emit("key", { key: "AG00", act: 1 });
    expect(handleInput).toHaveBeenCalledOnce();
    expect(harness.directRequests.some(({ method }) => method === "chat.send")).toBe(false);
    expect(harness.openedSessions).toEqual([]);

    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(stop).toHaveBeenCalledOnce();
    emit("key", { key: "AG00", act: 0, sessionKey: "agent:main:second" });
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    emit("radial", { angle: 0, distance: 0 });
    emit("key", { key: "AG00", act: 1 });
    emit("key", { key: "AG00", act: 0 });
    await harness.waitForReceiptCount(1);

    expect(harness.openedSessions).toContainEqual({
      sessionKey: "agent:main:first",
      agentId: "main",
    });
    expect(setDraft).not.toHaveBeenCalled();
    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toEqual([]);
    gameAttachment.detach();
    controller.dispose();
    focus.mockRestore();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusChatComposerFromPrintableKeydown } from "../../../ui/src/pages/chat/chat-pane-shared.ts";
import type { MicroInput } from "../contract.js";
import {
  CircularGameActivation,
  applyGameJoystick,
  createMicroGame,
  handleMicroGameInput,
  mountMicroGames,
  stepMicroGame,
} from "./games.js";

function radial(sequence: number, angle: number, distance: number): MicroInput {
  return {
    clientId: "micro-test",
    connectionId: "connection-test",
    sequence,
    kind: "radial",
    angle,
    distance,
    sessionKey: "agent:main:first",
  };
}

describe("Codex Micro games", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("simulates Snake movement and growth and Brick Breaker steering and hits", () => {
    const snake = createMicroGame("snake", () => 0);
    if (snake.id !== "snake") {
      throw new Error("Expected Snake game");
    }
    snake.food = { x: 12, y: 6 };
    applyGameJoystick(snake, 0.75, 0.8);
    stepMicroGame(snake, 0.05, () => 0);
    stepMicroGame(snake, 0.05, () => 0);
    stepMicroGame(snake, 0.05, () => 0);
    expect(snake.snake[0]).toEqual({ x: 12, y: 6 });
    expect(snake.snake).toHaveLength(4);
    expect(snake.score).toBe(10);

    const brickBreaker = createMicroGame("brick-breaker");
    if (brickBreaker.id !== "brick-breaker") {
      throw new Error("Expected Brick Breaker game");
    }
    applyGameJoystick(brickBreaker, 0, 1);
    brickBreaker.ball = { x: 30, y: 44, vx: 0, vy: -100, radius: 6 };
    stepMicroGame(brickBreaker, 0.01);
    expect(brickBreaker.paddle.x).toBeGreaterThan(240);
    expect(brickBreaker.bricks).toHaveLength(39);
    expect(brickBreaker.score).toBe(10);
  });

  it("fires Asteroids from AG00 and detects collisions across the screen edge", () => {
    const asteroids = createMicroGame("asteroids");
    if (asteroids.id !== "asteroids") {
      throw new Error("Expected Asteroids game");
    }
    applyGameJoystick(asteroids, 0.75, 1);
    stepMicroGame(asteroids, 0.05);
    expect(asteroids.ship.vy).toBeLessThan(0);
    handleMicroGameInput(asteroids, {
      clientId: "micro-test",
      connectionId: "connection-test",
      sequence: 1,
      kind: "key",
      key: "AG00",
      act: 1,
      sessionKey: "agent:main:first",
    });
    expect(asteroids.bullets).toHaveLength(1);

    asteroids.asteroids = [{ x: 1, y: 100, vx: 0, vy: 0, radius: 5 }];
    asteroids.bullets = [{ x: 478, y: 100, vx: 0, vy: 0, life: 1 }];
    asteroids.ship.invulnerable = 1;
    stepMicroGame(asteroids, 0.01);
    expect(asteroids.asteroids).toHaveLength(0);
    expect(asteroids.score).toBe(10);
    expect(asteroids.status).toBe("won");
  });

  it("preserves a completed flick and consumes clear circle progress", () => {
    const activation = new CircularGameActivation();
    expect(activation.handle(radial(1, 0.75, 0.8), 0)).toEqual({ kind: "pending" });
    const flick = activation.handle(radial(2, 0.75, 0), 120);
    expect(flick.kind).toBe("passthrough");
    expect("replay" in flick ? flick.replay?.sequence : undefined).toBe(1);

    expect(activation.handle(radial(3, 0, 0.8), 200).kind).toBe("pending");
    for (let index = 1; index <= 10; index += 1) {
      activation.handle(radial(index + 3, (index * 0.025) % 1, 0.8), 200 + index * 40);
    }
    const gap = activation.handle(radial(14, 0.3, 0.8), 1_700);
    expect(gap.kind).toBe("pending");
    expect("replay" in gap ? gap.replay : undefined).toBeUndefined();
    const end = activation.handle(radial(15, 0, 0), 1_740);
    expect(end.kind).toBe("passthrough");
    expect("replay" in end ? end.replay : undefined).toBeUndefined();

    activation.handle(radial(16, 0.2, 0.8), 2_000);
    let result: ReturnType<CircularGameActivation["handle"]> = { kind: "pending" };
    for (let index = 1; index <= 80; index += 1) {
      result = activation.handle(
        radial(index + 16, (0.2 + index * 0.025) % 1, 0.8),
        2_000 + index * 40,
      );
      if (result.kind === "activated") {
        break;
      }
    }
    expect(result.kind).toBe("activated");
  });

  it("offers accessible keyboard games without hardware and leaves the composer draft alone", () => {
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", () => ++nextFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const chatRoot = document.createElement("div");
    const container = document.createElement("div");
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const composerDraft = document.createElement("textarea");
    composerDraft.value = "Unchanged composer draft";
    composer.append(composerDraft);
    chatRoot.append(container, composer);
    document.body.append(chatRoot);
    chatRoot.addEventListener(
      "keydown",
      (event) => focusChatComposerFromPrintableKeydown(chatRoot, event),
      true,
    );
    const onStart = vi.fn();
    const onExit = vi.fn();
    const surface = mountMicroGames(container, { onStart, onExit });

    const launcher = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Games",
    );
    expect(launcher).toBeDefined();
    launcher?.click();
    expect(launcher?.getAttribute("aria-expanded")).toBe("true");
    const snakeButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Snake",
    );
    snakeButton?.click();
    expect(surface.active).toBe(true);
    expect(onStart).toHaveBeenCalledOnce();

    const gameTitle = container.querySelector(".micro-games__heading h2");
    const gameRoot = container.querySelector(".micro-games");
    expect(gameTitle?.textContent).toBe("Snake");
    expect(gameRoot?.hasAttribute("data-chat-autotype-exempt")).toBe(true);

    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-label")).toContain("Snake game");
    const arrow = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    canvas?.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    const asteroidsButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Asteroids",
    );
    surface.stop();
    asteroidsButton?.click();
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart",
    );
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    restart?.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    restart?.click();
    expect(surface.active).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(3);
    expect(onExit).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(canvas);
    expect(gameTitle?.textContent).toBe("Asteroids");
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    canvas?.dispatchEvent(space);
    const thrust = new KeyboardEvent("keydown", { key: "w", bubbles: true, cancelable: true });
    canvas?.dispatchEvent(thrust);
    expect(space.defaultPrevented).toBe(true);
    expect(thrust.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(composerDraft.value).toBe("Unchanged composer draft");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    canvas?.dispatchEvent(escape);
    expect(surface.active).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(composerDraft.value).toBe("Unchanged composer draft");
    surface.dispose();
  });
});

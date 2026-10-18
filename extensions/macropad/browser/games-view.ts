import type { MicroInput } from "../contract.js";
import {
  GAME_IDS,
  GAME_NAMES,
  HEIGHT,
  WIDTH,
  applyGameKey,
  createMicroGame,
  directionForKey,
  handleMicroGameInput,
  randomIndex,
  stepMicroGame,
  type MicroGame,
  type MicroGameId,
} from "./games-engine.js";

type GameColors = { background: string; foreground: string; accent: string; muted: string };

function color(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function gameColors(element: HTMLElement): GameColors {
  return {
    background: color(element, "--surface-raised", "#18191b"),
    foreground: color(element, "--text-primary", "#f4f5f6"),
    accent: color(element, "--accent", "#8b8cf6"),
    muted: color(element, "--text-secondary", "#a5a8ad"),
  };
}

function renderGame(context: CanvasRenderingContext2D, game: MicroGame, colors: GameColors): void {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = colors.background;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = "rgba(255,255,255,.08)";
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);
  context.fillStyle = colors.foreground;
  context.strokeStyle = colors.foreground;
  context.lineWidth = 2;

  if (game.id === "snake") {
    const cell = 20;
    game.snake.forEach((part, index) => {
      context.fillStyle = index === 0 ? colors.accent : colors.foreground;
      context.fillRect(part.x * cell + 2, part.y * cell + 2, cell - 4, cell - 4);
    });
    context.fillStyle = "#f18467";
    context.beginPath();
    context.arc(game.food.x * cell + cell / 2, game.food.y * cell + cell / 2, 6, 0, Math.PI * 2);
    context.fill();
  } else if (game.id === "brick-breaker") {
    game.bricks.forEach((brick, index) => {
      context.fillStyle = index % 2 === 0 ? colors.accent : colors.foreground;
      context.fillRect(brick.x, brick.y, brick.width, brick.height);
    });
    context.fillStyle = colors.foreground;
    context.fillRect(
      game.paddle.x - game.paddle.width / 2,
      game.paddle.y - game.paddle.height / 2,
      game.paddle.width,
      game.paddle.height,
    );
    context.beginPath();
    context.arc(game.ball.x, game.ball.y, game.ball.radius, 0, Math.PI * 2);
    context.fill();
  } else {
    for (const asteroid of game.asteroids) {
      context.beginPath();
      context.arc(asteroid.x, asteroid.y, asteroid.radius, 0, Math.PI * 2);
      context.stroke();
    }
    for (const bullet of game.bullets) {
      context.fillRect(bullet.x - 2, bullet.y - 2, 4, 4);
    }
    if (game.ship.invulnerable <= 0 || Math.floor(game.ship.invulnerable * 12) % 2 === 0) {
      const noseX = Math.cos(game.ship.angle);
      const noseY = Math.sin(game.ship.angle);
      context.beginPath();
      context.moveTo(game.ship.x + noseX * 12, game.ship.y + noseY * 12);
      context.lineTo(game.ship.x - noseX * 9 - noseY * 8, game.ship.y - noseY * 9 + noseX * 8);
      context.lineTo(game.ship.x - noseX * 9 + noseY * 8, game.ship.y - noseY * 9 - noseX * 8);
      context.closePath();
      context.stroke();
    }
  }

  if (game.status !== "playing") {
    context.fillStyle = "rgba(0,0,0,.58)";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = colors.foreground;
    context.textAlign = "center";
    context.font = "600 22px system-ui, sans-serif";
    context.fillText(game.status === "won" ? "You cleared it" : "Game over", WIDTH / 2, HEIGHT / 2);
  }
}

function gameMessage(game: MicroGame): string {
  const score = "Score " + game.score;
  if (game.status === "won") {
    return GAME_NAMES[game.id] + " complete · " + score;
  }
  if (game.status === "over") {
    return GAME_NAMES[game.id] + " game over · " + score + " · Restart to play again";
  }
  const lives =
    game.id === "snake" ? "" : " · " + game.lives + (game.lives === 1 ? " life" : " lives");
  return GAME_NAMES[game.id] + " · " + score + lives;
}

export interface MicroGamesSurface {
  readonly active: boolean;
  startRandom(): void;
  handleInput(input: MicroInput): void;
  stop(restoreFocus?: boolean): void;
  dispose(): void;
}

export function mountMicroGames(
  container: HTMLElement,
  options: { onStart: () => void; onExit: () => void },
): MicroGamesSurface {
  const root = document.createElement("section");
  root.className = "micro-games";
  root.setAttribute("aria-label", "Codex Micro games");
  root.setAttribute("data-chat-autotype-exempt", "");
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "micro-games__launcher";
  launcher.textContent = "Games";
  launcher.setAttribute("aria-expanded", "false");
  const chooser = document.createElement("div");
  chooser.className = "micro-games__chooser";
  chooser.hidden = true;
  const chooserTitle = document.createElement("h2");
  chooserTitle.textContent = "Choose a game";
  const chooserHelp = document.createElement("p");
  chooserHelp.textContent = "Use arrow keys or WASD. The Micro joystick also works.";
  const choices = document.createElement("div");
  choices.className = "micro-games__choices";
  const randomButton = document.createElement("button");
  randomButton.type = "button";
  randomButton.textContent = "Surprise me";
  choices.append(randomButton);
  for (const id of GAME_IDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = GAME_NAMES[id];
    button.addEventListener("click", () => start(id));
    choices.append(button);
  }
  chooser.append(chooserTitle, chooserHelp, choices);

  const panel = document.createElement("div");
  panel.className = "micro-games__panel";
  panel.hidden = true;
  const heading = document.createElement("div");
  heading.className = "micro-games__heading";
  const title = document.createElement("h2");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const canvas = document.createElement("canvas");
  canvas.className = "micro-games__canvas";
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Game canvas");
  const controlButtons = document.createElement("div");
  controlButtons.className = "micro-games__controls";
  const restart = document.createElement("button");
  restart.type = "button";
  restart.textContent = "Restart";
  const exit = document.createElement("button");
  exit.type = "button";
  exit.textContent = "Exit game";
  controlButtons.append(restart, exit);
  heading.append(title, controlButtons);
  const keyboardHelp = document.createElement("p");
  keyboardHelp.className = "micro-games__help";
  keyboardHelp.textContent = "Arrows or WASD to move · Space fires in Asteroids · Escape exits";
  panel.append(heading, status, canvas, keyboardHelp);
  root.append(launcher, chooser, panel);
  container.replaceChildren(root);

  let game: MicroGame | null = null;
  let active = false;
  let animationFrame = 0;
  let previousFrame = 0;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    context = null;
  }

  const render = () => {
    if (!game) {
      return;
    }
    status.textContent = gameMessage(game);
    canvas.setAttribute("aria-label", GAME_NAMES[game.id] + " game. " + status.textContent);
    if (context) {
      renderGame(context, game, gameColors(root));
    }
  };
  const stopLoop = () => {
    if (animationFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animationFrame);
    }
    animationFrame = 0;
    previousFrame = 0;
  };
  const frame = (now: number) => {
    if (!active || !game) {
      return;
    }
    const elapsed = previousFrame === 0 ? 0 : (now - previousFrame) / 1_000;
    previousFrame = now;
    stepMicroGame(game, elapsed);
    render();
    if (game.status === "playing") {
      animationFrame = requestAnimationFrame(frame);
    } else {
      animationFrame = 0;
    }
  };
  const start = (id: MicroGameId) => {
    stopLoop();
    game = createMicroGame(id);
    title.textContent = GAME_NAMES[id];
    active = true;
    launcher.setAttribute("aria-expanded", "false");
    chooser.hidden = true;
    panel.hidden = false;
    options.onStart();
    render();
    canvas.focus({ preventScroll: true });
    animationFrame = requestAnimationFrame(frame);
  };
  const exitGame = (restoreFocus = true) => {
    if (!active) {
      return;
    }
    active = false;
    stopLoop();
    game = null;
    panel.hidden = true;
    chooser.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    options.onExit();
    if (restoreFocus) {
      launcher.focus({ preventScroll: true });
    }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!active || !game || event.target !== canvas) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      exitGame();
      return;
    }
    const direction = directionForKey(event.key);
    const supported = direction !== null || event.key === " " || event.key === "Spacebar";
    if (!supported) {
      return;
    }
    event.preventDefault();
    if (applyGameKey(game, event.key, true)) {
      render();
    }
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!active || !game || event.target !== canvas) {
      return;
    }
    applyGameKey(game, event.key, false);
  };
  const clearKeys = () => {
    if (game) {
      game.controls.keys.clear();
    }
  };
  const onCanvasBlur = () => clearKeys();
  const retainCanvasFocus = (event: PointerEvent) => {
    if (active && event.button === 0) {
      event.preventDefault();
    }
  };
  canvas.addEventListener("blur", onCanvasBlur);
  controlButtons.addEventListener("pointerdown", retainCanvasFocus);
  launcher.addEventListener("click", () => {
    chooser.hidden = !chooser.hidden;
    launcher.setAttribute("aria-expanded", String(!chooser.hidden));
    if (!chooser.hidden) {
      choices.querySelector<HTMLButtonElement>("button")?.focus();
    }
  });
  randomButton.addEventListener("click", () => {
    const id = GAME_IDS[randomIndex(GAME_IDS.length, Math.random)]!;
    start(id);
  });
  restart.addEventListener("click", () => {
    if (game) {
      start(game.id);
    }
  });
  exit.addEventListener("click", () => exitGame());
  root.addEventListener("keydown", keyDown);
  root.addEventListener("keyup", keyUp);
  root.addEventListener("focusout", (event) => {
    if (active && event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) {
      clearKeys();
      exitGame();
    }
  });

  return {
    get active() {
      return active;
    },
    startRandom() {
      const id = GAME_IDS[randomIndex(GAME_IDS.length, Math.random)]!;
      start(id);
    },
    handleInput(input) {
      if (!active || !game) {
        return;
      }
      if (input.kind === "key" && input.key === "AG00" && input.act === 1) {
        handleMicroGameInput(game, input);
      } else if (input.kind === "radial") {
        handleMicroGameInput(game, input);
      }
      render();
    },
    stop: (restoreFocus = true) => exitGame(restoreFocus),
    dispose() {
      exitGame(false);
      root.removeEventListener("keydown", keyDown);
      root.removeEventListener("keyup", keyUp);
      canvas.removeEventListener("blur", onCanvasBlur);
      controlButtons.removeEventListener("pointerdown", retainCanvasFocus);
      stopLoop();
      container.replaceChildren();
    },
  };
}

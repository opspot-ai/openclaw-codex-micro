import type { MicroInput } from "../contract.js";

export type MicroGameId = "snake" | "brick-breaker" | "asteroids";
type Direction = "up" | "right" | "down" | "left";
type Point = { x: number; y: number };
type Controls = { joystick: Point; keys: Set<string> };
type GameStatus = "playing" | "won" | "over";

type GameBase = {
  id: MicroGameId;
  score: number;
  status: GameStatus;
  controls: Controls;
};

type SnakeGame = GameBase & {
  id: "snake";
  snake: Point[];
  food: Point;
  direction: Direction;
  nextDirection: Direction;
  elapsed: number;
};

type BrickBreakerGame = GameBase & {
  id: "brick-breaker";
  ball: Point & { vx: number; vy: number; radius: number };
  paddle: { x: number; y: number; width: number; height: number };
  bricks: Array<{ x: number; y: number; width: number; height: number }>;
  lives: number;
};

type AsteroidsGame = GameBase & {
  id: "asteroids";
  ship: Point & { vx: number; vy: number; angle: number; invulnerable: number };
  asteroids: Array<Point & { vx: number; vy: number; radius: number }>;
  bullets: Array<Point & { vx: number; vy: number; life: number }>;
  lives: number;
  fireCooldown: number;
};

export type MicroGame = SnakeGame | BrickBreakerGame | AsteroidsGame;

export const WIDTH = 480;
export const HEIGHT = 300;
export const GAME_IDS: MicroGameId[] = ["snake", "brick-breaker", "asteroids"];
export const GAME_NAMES: Record<MicroGameId, string> = {
  snake: "Snake",
  "brick-breaker": "Brick Breaker",
  asteroids: "Asteroids",
};

function controls(): Controls {
  return { joystick: { x: 0, y: 0 }, keys: new Set() };
}

export function randomIndex(count: number, random: () => number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
}

export function createMicroGame(id: MicroGameId, random = Math.random): MicroGame {
  if (id === "snake") {
    const center = { x: 12, y: 7 };
    const game: SnakeGame = {
      id,
      score: 0,
      status: "playing",
      controls: controls(),
      snake: [center, { x: 11, y: 7 }, { x: 10, y: 7 }],
      food: { x: 18, y: 7 },
      direction: "right",
      nextDirection: "right",
      elapsed: 0,
    };
    placeFood(game, random);
    return game;
  }

  if (id === "brick-breaker") {
    const bricks = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        bricks.push({
          x: 14 + column * 57,
          y: 30 + row * 20,
          width: 49,
          height: 12,
        });
      }
    }
    return {
      id,
      score: 0,
      status: "playing",
      controls: controls(),
      ball: { x: WIDTH / 2, y: 218, vx: 150, vy: -175, radius: 6 },
      paddle: { x: WIDTH / 2, y: 270, width: 76, height: 9 },
      bricks,
      lives: 3,
    };
  }

  return {
    id,
    score: 0,
    status: "playing",
    controls: controls(),
    ship: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, angle: -Math.PI / 2, invulnerable: 0 },
    asteroids: [
      { x: 240, y: 88, vx: 18, vy: 8, radius: 18 },
      { x: 112, y: 124, vx: -12, vy: 16, radius: 15 },
      { x: 348, y: 210, vx: -17, vy: -10, radius: 20 },
      { x: 88, y: 238, vx: 14, vy: -12, radius: 13 },
      { x: 386, y: 54, vx: -16, vy: 14, radius: 16 },
    ],
    bullets: [],
    lives: 3,
    fireCooldown: 0,
  };
}

function placeFood(game: SnakeGame, random: () => number): void {
  const available: Point[] = [];
  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      if (!game.snake.some((part) => part.x === x && part.y === y)) {
        available.push({ x, y });
      }
    }
  }
  if (available.length === 0) {
    game.status = "won";
    return;
  }
  game.food = available[randomIndex(available.length, random)]!;
}

function directionForAngle(angle: number): Direction {
  const normalized = ((angle % 1) + 1) % 1;
  if (normalized >= 0.625 && normalized < 0.875) {
    return "up";
  }
  if (normalized >= 0.125 && normalized < 0.375) {
    return "down";
  }
  if (normalized >= 0.375 && normalized < 0.625) {
    return "left";
  }
  return "right";
}

function opposite(direction: Direction): Direction {
  return direction === "up"
    ? "down"
    : direction === "down"
      ? "up"
      : direction === "left"
        ? "right"
        : "left";
}

export function applyGameJoystick(game: MicroGame, angle: number, distance: number): void {
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) {
    return;
  }
  if (distance <= 0.1) {
    game.controls.joystick = { x: 0, y: 0 };
    return;
  }
  const radians = angle * Math.PI * 2;
  const vector = { x: Math.cos(radians) * distance, y: Math.sin(radians) * distance };
  game.controls.joystick = vector;
  if (game.id === "snake" && distance >= 0.2) {
    const next = directionForAngle(angle);
    if (next !== opposite(game.direction)) {
      game.nextDirection = next;
    }
  }
}

export function directionForKey(key: string): Direction | null {
  const normalized = key.toLowerCase();
  if (normalized === "arrowup" || normalized === "w") {
    return "up";
  }
  if (normalized === "arrowright" || normalized === "d") {
    return "right";
  }
  if (normalized === "arrowdown" || normalized === "s") {
    return "down";
  }
  if (normalized === "arrowleft" || normalized === "a") {
    return "left";
  }
  return null;
}

export function applyGameKey(game: MicroGame, key: string, pressed: boolean): boolean {
  const normalized = key.toLowerCase();
  if (pressed) {
    if (game.controls.keys.has(normalized)) {
      return false;
    }
    game.controls.keys.add(normalized);
    const direction = directionForKey(key);
    if (game.id === "snake" && direction && direction !== opposite(game.direction)) {
      game.nextDirection = direction;
    }
    if (game.id === "asteroids" && (normalized === " " || normalized === "space")) {
      fireAsteroids(game);
    }
    return true;
  }
  game.controls.keys.delete(normalized);
  return false;
}

function fireAsteroids(game: AsteroidsGame): void {
  if (game.status !== "playing" || game.fireCooldown > 0) {
    return;
  }
  const noseX = Math.cos(game.ship.angle);
  const noseY = Math.sin(game.ship.angle);
  game.bullets.push({
    x: game.ship.x + noseX * 14,
    y: game.ship.y + noseY * 14,
    vx: game.ship.vx + noseX * 280,
    vy: game.ship.vy + noseY * 280,
    life: 1.1,
  });
  game.fireCooldown = 0.22;
}

export function handleMicroGameInput(game: MicroGame, input: MicroInput): void {
  if (game.status !== "playing") {
    return;
  }
  if (input.kind === "radial") {
    if (typeof input.angle === "number" && typeof input.distance === "number") {
      applyGameJoystick(game, input.angle, input.distance);
    }
    return;
  }
  if (input.key === "AG00" && input.act === 1 && game.id === "asteroids") {
    fireAsteroids(game);
  }
}

export function stepMicroGame(game: MicroGame, elapsedSeconds: number, random = Math.random): void {
  if (game.status !== "playing" || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return;
  }
  const elapsed = Math.min(elapsedSeconds, 0.05);
  if (game.id === "snake") {
    stepSnake(game, elapsed, random);
  } else if (game.id === "brick-breaker") {
    stepBrickBreaker(game, elapsed);
  } else {
    stepAsteroids(game, elapsed);
  }
}

function stepSnake(game: SnakeGame, elapsed: number, random: () => number): void {
  game.elapsed += elapsed;
  while (game.elapsed >= 0.13 && game.status === "playing") {
    game.elapsed -= 0.13;
    game.direction = game.nextDirection;
    const head = game.snake[0]!;
    const next = {
      x: head.x + (game.direction === "right" ? 1 : game.direction === "left" ? -1 : 0),
      y: head.y + (game.direction === "down" ? 1 : game.direction === "up" ? -1 : 0),
    };
    const eating = next.x === game.food.x && next.y === game.food.y;
    const occupied = eating ? game.snake : game.snake.slice(0, -1);
    if (
      next.x < 0 ||
      next.x >= 24 ||
      next.y < 0 ||
      next.y >= 15 ||
      occupied.some((part) => part.x === next.x && part.y === next.y)
    ) {
      game.status = "over";
      return;
    }
    game.snake.unshift(next);
    if (eating) {
      game.score += 10;
      placeFood(game, random);
    } else {
      game.snake.pop();
    }
  }
}

function keyboardAxis(keys: Set<string>, negative: string, positive: string): number {
  return Number(keys.has(positive)) - Number(keys.has(negative));
}

function stepBrickBreaker(game: BrickBreakerGame, elapsed: number): void {
  const keyboard =
    keyboardAxis(game.controls.keys, "arrowleft", "arrowright") ||
    keyboardAxis(game.controls.keys, "a", "d");
  const movement = keyboard || game.controls.joystick.x;
  game.paddle.x = Math.max(
    game.paddle.width / 2,
    Math.min(WIDTH - game.paddle.width / 2, game.paddle.x + movement * 260 * elapsed),
  );

  game.ball.x += game.ball.vx * elapsed;
  game.ball.y += game.ball.vy * elapsed;
  if (game.ball.x <= game.ball.radius || game.ball.x >= WIDTH - game.ball.radius) {
    game.ball.vx *= -1;
    game.ball.x = Math.max(game.ball.radius, Math.min(WIDTH - game.ball.radius, game.ball.x));
  }
  if (game.ball.y <= game.ball.radius) {
    game.ball.vy = Math.abs(game.ball.vy);
  }
  const paddleTop = game.paddle.y - game.paddle.height / 2;
  if (
    game.ball.vy > 0 &&
    game.ball.y + game.ball.radius >= paddleTop &&
    game.ball.y <= game.paddle.y &&
    Math.abs(game.ball.x - game.paddle.x) <= game.paddle.width / 2 + game.ball.radius
  ) {
    const offset = (game.ball.x - game.paddle.x) / (game.paddle.width / 2);
    game.ball.vx = Math.max(-240, Math.min(240, game.ball.vx + offset * 90));
    game.ball.vy = -Math.max(145, Math.abs(game.ball.vy));
    game.ball.y = paddleTop - game.ball.radius;
  }
  if (game.ball.y > HEIGHT + game.ball.radius) {
    game.lives -= 1;
    if (game.lives <= 0) {
      game.status = "over";
      return;
    }
    game.ball.x = game.paddle.x;
    game.ball.y = 218;
    game.ball.vx = 150;
    game.ball.vy = -175;
  }

  const hitIndex = game.bricks.findIndex(
    (brick) =>
      game.ball.x + game.ball.radius >= brick.x &&
      game.ball.x - game.ball.radius <= brick.x + brick.width &&
      game.ball.y + game.ball.radius >= brick.y &&
      game.ball.y - game.ball.radius <= brick.y + brick.height,
  );
  if (hitIndex >= 0) {
    game.bricks.splice(hitIndex, 1);
    game.ball.vy *= -1;
    game.score += 10;
    if (game.bricks.length === 0) {
      game.status = "won";
    }
  }
}

function wrap(value: number, limit: number): number {
  return value < 0 ? value + limit : value >= limit ? value - limit : value;
}

function toroidalDistance(left: Point, right: Point): number {
  const dx = Math.abs(left.x - right.x);
  const dy = Math.abs(left.y - right.y);
  return Math.hypot(Math.min(dx, WIDTH - dx), Math.min(dy, HEIGHT - dy));
}

function stepAsteroids(game: AsteroidsGame, elapsed: number): void {
  const keys = game.controls.keys;
  const turn =
    keyboardAxis(keys, "arrowleft", "arrowright") +
    keyboardAxis(keys, "a", "d") +
    game.controls.joystick.x;
  const thrust =
    Number(keys.has("arrowup") || keys.has("w")) + Math.max(0, -game.controls.joystick.y);
  game.ship.angle += turn * 3.5 * elapsed;
  if (thrust > 0) {
    game.ship.vx += Math.cos(game.ship.angle) * 190 * Math.min(1, thrust) * elapsed;
    game.ship.vy += Math.sin(game.ship.angle) * 190 * Math.min(1, thrust) * elapsed;
  }
  const friction = 0.985 ** (elapsed * 60);
  game.ship.vx *= friction;
  game.ship.vy *= friction;
  game.ship.x = wrap(game.ship.x + game.ship.vx * elapsed, WIDTH);
  game.ship.y = wrap(game.ship.y + game.ship.vy * elapsed, HEIGHT);
  game.ship.invulnerable = Math.max(0, game.ship.invulnerable - elapsed);
  game.fireCooldown = Math.max(0, game.fireCooldown - elapsed);

  for (const asteroid of game.asteroids) {
    asteroid.x = wrap(asteroid.x + asteroid.vx * elapsed, WIDTH);
    asteroid.y = wrap(asteroid.y + asteroid.vy * elapsed, HEIGHT);
  }
  for (const bullet of game.bullets) {
    bullet.x = wrap(bullet.x + bullet.vx * elapsed, WIDTH);
    bullet.y = wrap(bullet.y + bullet.vy * elapsed, HEIGHT);
    bullet.life -= elapsed;
  }
  game.bullets = game.bullets.filter((bullet) => bullet.life > 0);

  const hitBulletIndexes = new Set<number>();
  game.asteroids = game.asteroids.filter((asteroid) => {
    const bulletIndex = game.bullets.findIndex(
      (bullet, index) =>
        !hitBulletIndexes.has(index) && toroidalDistance(asteroid, bullet) <= asteroid.radius,
    );
    if (bulletIndex < 0) {
      return true;
    }
    hitBulletIndexes.add(bulletIndex);
    game.score += 10;
    return false;
  });
  if (hitBulletIndexes.size) {
    game.bullets = game.bullets.filter((_, index) => !hitBulletIndexes.has(index));
  }
  if (game.asteroids.length === 0) {
    game.status = "won";
    return;
  }
  if (
    game.ship.invulnerable === 0 &&
    game.asteroids.some((asteroid) => toroidalDistance(asteroid, game.ship) < asteroid.radius + 9)
  ) {
    game.lives -= 1;
    if (game.lives <= 0) {
      game.status = "over";
      return;
    }
    game.ship.x = WIDTH / 2;
    game.ship.y = HEIGHT / 2;
    game.ship.vx = 0;
    game.ship.vy = 0;
    game.ship.invulnerable = 1;
  }
}

type GameActivationResult =
  | { kind: "pending"; replay?: MicroInput }
  | { kind: "activated" }
  | { kind: "passthrough"; replay?: MicroInput };

type CircularRadialInput = MicroInput & { kind: "radial"; angle: number; distance: number };

function circularRadialInput(input: MicroInput): CircularRadialInput | null {
  if (
    input.kind !== "radial" ||
    typeof input.angle !== "number" ||
    typeof input.distance !== "number" ||
    !Number.isFinite(input.angle) ||
    !Number.isFinite(input.distance)
  ) {
    return null;
  }
  return { ...input, kind: "radial", angle: input.angle, distance: input.distance };
}

export class CircularGameActivation {
  private startedAt: number | null = null;
  private lastAt = 0;
  private lastAngle = 0;
  private direction = 0;
  private turns = 0;
  private consumingCircle = false;
  private fallback: MicroInput | null = null;

  get pending(): boolean {
    return this.startedAt !== null;
  }

  reset(): MicroInput | null {
    const fallback = this.fallback;
    this.clear();
    return fallback;
  }

  handle(input: MicroInput, now: number): GameActivationResult {
    const radial = circularRadialInput(input);
    if (!radial) {
      const replay = this.reset() ?? undefined;
      return { kind: "passthrough", ...(replay ? { replay } : {}) };
    }
    const distance = radial.distance;
    if (distance < 0.2) {
      const replay = this.reset() ?? undefined;
      return { kind: "passthrough", ...(replay ? { replay } : {}) };
    }

    if (this.startedAt === null) {
      this.begin(radial, now);
      return { kind: "pending" };
    }

    if (now - this.startedAt > 6_000 || now - this.lastAt > 1_000) {
      const replay = this.fallback ?? undefined;
      this.begin(radial, now, this.consumingCircle);
      return { kind: "pending", ...(replay ? { replay } : {}) };
    }
    const delta = this.angleDelta(radial.angle, this.lastAngle);
    if (Math.abs(delta) > 0.45 || (this.direction !== 0 && delta * this.direction < -0.03)) {
      const replay = this.fallback ?? undefined;
      this.begin(radial, now, this.consumingCircle);
      return { kind: "pending", ...(replay ? { replay } : {}) };
    }
    if (Math.abs(delta) >= 0.008) {
      this.direction = Math.sign(delta);
      this.turns += Math.abs(delta);
    }
    if (this.turns >= 0.2) {
      this.consumingCircle = true;
      this.fallback = null;
    }
    this.lastAt = now;
    this.lastAngle = radial.angle;
    if (this.turns >= 1.8) {
      this.clear();
      return { kind: "activated" };
    }
    if (!this.consumingCircle && this.fallback === null && distance >= 0.5) {
      this.fallback = input;
    }
    return { kind: "pending" };
  }

  private begin(input: CircularRadialInput, now: number, preserveCircle = false): void {
    this.consumingCircle = preserveCircle;
    this.startedAt = now;
    this.lastAt = now;
    this.lastAngle = input.angle;
    this.direction = 0;
    this.turns = 0;
    this.fallback = !this.consumingCircle && input.distance >= 0.5 ? input : null;
  }

  private angleDelta(next: number, previous: number): number {
    let delta = next - previous;
    if (delta > 0.5) {
      delta -= 1;
    } else if (delta < -0.5) {
      delta += 1;
    }
    return delta;
  }

  private clear(): void {
    this.startedAt = null;
    this.lastAt = 0;
    this.lastAngle = 0;
    this.direction = 0;
    this.turns = 0;
    this.consumingCircle = false;
    this.fallback = null;
  }
}

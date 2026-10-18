import type { MicroReceipt, MicroSync } from "../contract.js";

export const MICRO_CONTROLLER_TTL_MS = 10_000;

const RECEIPT_TTL_MS = 10_000;
const MAX_PENDING_RECEIPTS = 128;

export type MicroController = {
  clientId: string;
  connectionId: string;
  focused: boolean;
  lastHeartbeat: number;
};

type PendingInputReceipt = { clientId: string; connectionId: string; createdAt: number };

/** Keeps the authenticated UI owner and its one-shot physical-input receipts. */
export class MicroControllerLease {
  #controller: MicroController | null = null;
  readonly #pendingReceipts = new Map<number, PendingInputReceipt>();
  #sequence = 0;

  get current(): MicroController | null {
    return this.#controller;
  }

  synchronize(input: MicroSync, connectionId: string, now: number): boolean {
    const existing = this.#controller;
    const sameController =
      existing?.clientId === input.clientId && existing.connectionId === connectionId;

    if (input.focused) {
      if (existing?.focused && !sameController) {
        return false;
      }
      this.#controller = {
        clientId: input.clientId,
        connectionId,
        focused: true,
        lastHeartbeat: now,
      };
      if (!sameController) {
        this.#pendingReceipts.clear();
      }
      return true;
    }

    if (!sameController || !existing) {
      return false;
    }
    this.#controller = { ...existing, focused: false, lastHeartbeat: now };
    return true;
  }

  matches(clientId: string, connectionId: string): boolean {
    return (
      this.#controller?.clientId === clientId && this.#controller.connectionId === connectionId
    );
  }

  isCurrent(controller: MicroController): boolean {
    return this.#controller === controller;
  }

  expireIfDue(now: number): boolean {
    if (!this.#controller || now - this.#controller.lastHeartbeat < MICRO_CONTROLLER_TTL_MS) {
      return false;
    }
    this.clear();
    return true;
  }

  clear(): void {
    this.#controller = null;
    this.#pendingReceipts.clear();
  }

  clearReceipts(): void {
    this.#pendingReceipts.clear();
  }

  nextSequence(): number {
    this.#sequence = this.#sequence >= Number.MAX_SAFE_INTEGER ? 1 : this.#sequence + 1;
    return this.#sequence;
  }

  rememberReceipt(sequence: number, clientId: string, connectionId: string, now: number): void {
    this.sweepReceipts(now);
    if (this.#pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
      return;
    }
    this.#pendingReceipts.set(sequence, { clientId, connectionId, createdAt: now });
  }

  discardReceipt(sequence: number): void {
    this.#pendingReceipts.delete(sequence);
  }

  consumeReceipt(
    clientId: string,
    receipt: MicroReceipt,
    connectionId: string,
    now: number,
  ): boolean {
    this.sweepReceipts(now);
    const pending = this.#pendingReceipts.get(receipt.sequence);
    if (
      !this.matches(clientId, connectionId) ||
      !pending ||
      pending.clientId !== clientId ||
      pending.connectionId !== connectionId ||
      now - pending.createdAt >= RECEIPT_TTL_MS
    ) {
      return false;
    }
    this.#pendingReceipts.delete(receipt.sequence);
    return true;
  }

  private sweepReceipts(now: number): void {
    for (const [sequence, pending] of this.#pendingReceipts) {
      if (now - pending.createdAt >= RECEIPT_TTL_MS) {
        this.#pendingReceipts.delete(sequence);
      }
    }
  }
}

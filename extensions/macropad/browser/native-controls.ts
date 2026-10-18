import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

type NativeFocusHost = ControlUiHost & {
  window?: { focus?: () => Promise<boolean> | boolean };
};

export class MicroNativeControls {
  constructor(
    private readonly host: NativeFocusHost,
    private readonly assertCurrent: (generation: number) => void,
  ) {}

  sendFocusedKey(key: "ArrowUp" | "ArrowDown" | "Enter", generation: number): string {
    this.assertCurrent(generation);
    if (!document.hasFocus()) {
      throw new Error("Focus the OpenClaw Control UI before using the encoder.");
    }
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || target === document.body || !target.isConnected) {
      throw new Error("The encoder needs a focused native Control UI control.");
    }
    if (key === "Enter" && target instanceof HTMLButtonElement) {
      if (target.disabled) {
        throw new Error("The focused native Control UI button is disabled.");
      }
      target.click();
    } else {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    }
    return `Sent ${key} to the focused native Control UI control.`;
  }

  moveHistory(direction: "back" | "forward", generation: number): string {
    this.assertCurrent(generation);
    if (!document.hasFocus()) {
      throw new Error("Focus the OpenClaw Control UI before navigating its history.");
    }
    if (direction === "back" && history.length <= 1) {
      throw new Error("There is no earlier Control UI page in browser history.");
    }
    if (direction === "back") {
      history.back();
    } else {
      history.forward();
    }
    return `Requested browser-history ${direction} in the current Control UI.`;
  }

  toggleSidebar(generation: number): string {
    this.assertCurrent(generation);
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse sidebar"], button[aria-label="Expand sidebar"]',
    );
    if (!button || button.disabled) {
      throw new Error("The native Control UI sidebar toggle is not currently available.");
    }
    button.click();
    return "Toggled the native Control UI sidebar.";
  }

  async focusWindow(generation: number): Promise<boolean> {
    this.assertCurrent(generation);
    const nativeFocus = this.host.window?.focus;
    if (nativeFocus) {
      const focused = await nativeFocus.call(this.host.window);
      this.assertCurrent(generation);
      return focused;
    }
    window.focus();
    this.assertCurrent(generation);
    return document.hasFocus();
  }
}

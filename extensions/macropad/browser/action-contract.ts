import type { ControlUiHost, ControlUiSurfaceProps } from "openclaw/plugin-sdk/control-ui";

type ComposerProps = ControlUiSurfaceProps["composer"];

export type FocusHost = ControlUiHost & {
  window?: { focus?: () => Promise<boolean> | boolean };
  links?: { openExternal?: (url: string) => Promise<boolean> };
};

export type MicroActionComposer = { props: ComposerProps; container: HTMLElement };
export type MicroActionCapability = "read" | "write" | "grant";

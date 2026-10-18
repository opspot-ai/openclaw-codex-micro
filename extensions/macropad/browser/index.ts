import {
  defineControlUiPlugin,
  type ControlUiSurfaceProps,
  type ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import "./styles.css";
import { MicroBrowserController } from "./controller.js";
import { mountMicroGames } from "./games.js";
import { mountMicroSettings } from "./settings.js";

type ComposerViewContext = ControlUiViewContext<ControlUiSurfaceProps["composer"]>;
type SessionListViewContext = ControlUiViewContext<ControlUiSurfaceProps["session-list"]>;

function deviceLabel(controller: MicroBrowserController): string {
  const snapshot = controller.snapshot();
  if (!snapshot.connected) {
    return "Disconnected";
  }
  if (!snapshot.device?.connected) {
    return snapshot.device?.error ?? "Device unavailable";
  }
  const battery = snapshot.device.battery;
  return `${snapshot.device.product ?? "Connected"}${battery === null || battery === undefined ? "" : ` · ${Math.round(battery)}%`}`;
}

function mountSidebarPill(
  container: HTMLElement,
  context: SessionListViewContext,
  controller: MicroBrowserController,
): { update: (next: SessionListViewContext) => void; dispose: () => void } {
  const root = document.createElement("div");
  root.className = "micro-session-list-replacement";
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "micro-status-pill";
  pill.setAttribute("aria-label", "Open Codex Micro settings and device status");
  pill.addEventListener("click", () => controller.openRoute("macropad"));
  const nativeList = document.createElement("div");
  nativeList.className = "micro-session-list-replacement__native";
  root.append(pill, nativeList);
  container.replaceChildren(root);
  const disposeDefault = context.mountDefault(nativeList);
  let currentContext = context;
  const render = () => {
    const snapshot = controller.snapshot();
    pill.textContent = `Codex Micro · ${deviceLabel(controller)}`;
    pill.dataset.connected = String(Boolean(snapshot.connected && snapshot.device?.connected));
    if (snapshot.device?.battery !== null && snapshot.device?.battery !== undefined) {
      pill.title = `${Math.round(snapshot.device.battery)}% battery${snapshot.device.charging ? " · charging" : ""}`;
    } else {
      pill.title = "Battery status unavailable";
    }
  };
  const unsubscribe = controller.subscribe(render);
  render();
  return {
    update: (next) => {
      if (next.props.sessions !== currentContext.props.sessions) {
        currentContext = next;
      }
      render();
    },
    dispose() {
      unsubscribe();
      disposeDefault();
      container.replaceChildren();
    },
  };
}

function mountComposer(
  container: HTMLElement,
  context: ComposerViewContext,
  controller: MicroBrowserController,
): { update: (next: ComposerViewContext) => void; dispose: () => void } {
  const root = document.createElement("div");
  root.className = "micro-composer-replacement";
  const gamesContainer = document.createElement("div");
  const nativeComposer = document.createElement("div");
  nativeComposer.className = "micro-composer-replacement__native";
  const status = document.createElement("div");
  status.className = "micro-composer-status";
  status.setAttribute("role", "status");
  root.append(gamesContainer, nativeComposer, status);
  container.replaceChildren(root);
  const disposeDefault = context.mountDefault(nativeComposer);
  const token = {};
  let gameAttachment: ReturnType<MicroBrowserController["attachGames"]> | null = null;
  const games = mountMicroGames(gamesContainer, {
    onStart: () => gameAttachment?.start(),
    onExit: () => gameAttachment?.exit(),
  });
  gameAttachment = controller.attachGames(games, token);
  let currentContext = context;
  const render = (next: ComposerViewContext) => {
    controller.setComposer(
      next.presented ? next.props : null,
      next.presented ? nativeComposer : null,
      token,
    );
    const snapshot = controller.snapshot();
    const detail = snapshot.receipt ?? deviceLabel(controller);
    const plan = snapshot.planMode === null ? "" : ` · Plan ${snapshot.planMode ? "on" : "off"}`;
    status.textContent = `Micro · ${detail}${plan}`;
    status.dataset.connected = String(Boolean(snapshot.connected && snapshot.device?.connected));
  };
  const unsubscribe = controller.subscribe(() => render(currentContext));
  render(currentContext);
  return {
    update(next) {
      currentContext = next;
      render(currentContext);
    },
    dispose() {
      unsubscribe();
      controller.setComposer(null, null, token);
      gameAttachment?.detach();
      games.dispose();
      disposeDefault();
      container.replaceChildren();
    },
  };
}

export default defineControlUiPlugin({
  id: "macropad",
  activate(host) {
    const controller = new MicroBrowserController(host);
    const registrations = [
      host.ui.registerPage({
        id: "macropad",
        label: "Codex Micro",
        mount: (container) => mountMicroSettings(container, controller),
      }),
      host.ui.registerNavigation({
        id: "macropad",
        label: "Codex Micro",
        page: { id: "macropad" },
        icon: "sliders",
        order: 84,
      }),
      host.ui.registerReplacement({
        id: "codex-micro-sidebar",
        label: "Codex Micro status pill",
        surface: "session-list",
        mount: (container, context) => mountSidebarPill(container, context, controller),
      }),
      host.ui.registerReplacement({
        id: "codex-micro-composer",
        label: "Codex Micro composer controls",
        surface: "composer",
        mount: (container, context) => mountComposer(container, context, controller),
      }),
    ];
    host.ui.selectReplacement("session-list", "codex-micro-sidebar");
    host.ui.selectReplacement("composer", "codex-micro-composer");
    controller.start();
    return () => {
      host.ui.selectReplacement("composer", null);
      host.ui.selectReplacement("session-list", null);
      for (const dispose of registrations.toReversed()) {
        dispose();
      }
      controller.dispose();
    };
  },
});

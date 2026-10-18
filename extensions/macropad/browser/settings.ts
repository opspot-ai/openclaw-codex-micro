import {
  defaultMicroPreferences,
  type MicroBinding,
  type MicroDevice,
  type MicroPreferences,
} from "../contract.js";

export type MicroSettingsSnapshot = {
  device: MicroDevice | null;
  preferences: MicroPreferences;
  sessions: readonly { key: string; title: string }[];
  connected: boolean;
  canWrite: boolean;
  preferencesReady: boolean;
  planMode: boolean | null;
  error: string | null;
  receipt: string | null;
};

export type MicroSettingsController = {
  snapshot: () => MicroSettingsSnapshot;
  updatePreferences: (preferences: MicroPreferences) => Promise<boolean>;
  identify: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  openRoute: (id: string) => void;
};

const autoDimOptions = [
  ["off", "Off"],
  ["30-seconds", "30 seconds"],
  ["1-minute", "1 minute"],
  ["3-minutes", "3 minutes"],
  ["10-minutes", "10 minutes"],
  ["30-minutes", "30 minutes"],
  ["1-hour", "1 hour"],
] as const;

const commandOptions = [
  ["fast", "Fast mode"],
  ["approve", "Approve once"],
  ["decline", "Decline approval"],
  ["fork", "Fork conversation"],
  ["microphone", "Composer microphone"],
  ["send", "Send composer draft"],
  ["plan", "Plan mode"],
  ["forward", "Navigate forward"],
  ["sidebar", "Toggle sidebar"],
  ["back", "Navigate back"],
  ["new-session", "New session"],
  ["stop", "Stop response"],
  ["settings", "Open settings"],
  ["files", "Open files"],
  ["skills", "Open skills"],
  ["enter", "Select focused control"],
  ["none", "No action"],
] as const;

const bindingRows = [
  ["ACT06", "FAST"],
  ["ACT07", "APPROVE"],
  ["ACT08", "DECLINE"],
  ["ACT09", "FORK"],
  ["ACT10", "MIC · left"],
  ["ACT11", "MIC · right"],
  ["ACT12", "CODEX · send"],
  ["up", "Stick · up"],
  ["right", "Stick · right"],
  ["down", "Stick · down"],
  ["left", "Stick · left"],
  ["ENC_CLK", "Encoder click"],
] as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = element("label", labelText);
  label.className = "micro-field";
  label.append(control);
  return label;
}

function selectControl<T extends string>(
  options: readonly (readonly [T, string])[],
  selected: string,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const select = element("select");
  for (const [value, label] of options) {
    const option = element("option", label);
    option.value = value;
    option.selected = value === selected;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const selectedOption = options.find(([value]) => value === select.value);
    if (selectedOption) {
      onChange(selectedOption[0]);
    }
  });
  return select;
}

function toggleControl(checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
  const input = element("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function pauseControls(section: HTMLElement, ready: boolean): void {
  if (ready) {
    return;
  }
  for (const control of section.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("input, select, button")) {
    control.disabled = true;
  }
}

function clonePreferences(preferences: MicroPreferences): MicroPreferences {
  return {
    ...preferences,
    customSessionKeys: [...preferences.customSessionKeys],
    bindings: Object.fromEntries(
      Object.entries(preferences.bindings).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function statusText(snapshot: MicroSettingsSnapshot): string {
  const device = snapshot.device;
  if (!snapshot.connected) {
    return "Control UI disconnected";
  }
  if (device?.connected) {
    return device.product ?? "Codex Micro connected";
  }
  return device?.error ?? "No Codex Micro connected";
}

export function mountMicroSettings(
  container: HTMLElement,
  controller: MicroSettingsController,
): { dispose: () => void } {
  let currentSnapshot = controller.snapshot();
  const render = () => {
    currentSnapshot = controller.snapshot();
    const root = element("section");
    root.className = "micro-settings";
    root.setAttribute("aria-label", "Codex Micro settings");

    const header = element("header");
    header.className = "micro-settings__header";
    const title = element("div");
    title.append(element("h1", "Codex Micro"));
    title.append(
      element("p", "Device, lighting, and physical controls for this Control UI connection."),
    );
    if (!currentSnapshot.preferencesReady) {
      const loading = element(
        "p",
        "Loading saved preferences. Settings and physical inputs are paused.",
      );
      loading.className = "micro-settings__notice";
      loading.setAttribute("role", "status");
      title.append(loading);
    }
    header.append(title);
    const identify = element("button", "Identify device");
    identify.type = "button";
    identify.disabled = !currentSnapshot.connected || !currentSnapshot.canWrite;
    identify.addEventListener("click", () => void controller.identify());
    header.append(identify);
    root.append(header);

    const connection = element("section");
    connection.className = "micro-card micro-card--connection";
    connection.append(element("h2", "Connection"));
    const connectionGrid = element("div");
    connectionGrid.className = "micro-settings__grid";
    connectionGrid.append(field("Status", element("output", statusText(currentSnapshot))));
    const battery = currentSnapshot.device?.battery;
    connectionGrid.append(
      field(
        "Battery",
        element(
          "output",
          battery === null || battery === undefined
            ? "Unavailable"
            : `${Math.round(battery)}%${currentSnapshot.device?.charging ? " · charging" : ""}`,
        ),
      ),
    );
    const permission = currentSnapshot.device?.inputPermission ?? "unknown";
    const inputStatus =
      permission === "granted"
        ? "Granted"
        : permission === "denied"
          ? "Denied · allow Input Monitoring in macOS Privacy & Security"
          : permission === "unsupported"
            ? "Unsupported on this platform"
            : "Unknown · connect the device to check";
    connectionGrid.append(field("Input Monitoring", element("output", inputStatus)));
    connection.append(connectionGrid);
    if (currentSnapshot.device?.error) {
      const error = element("p", currentSnapshot.device.error);
      error.className = "micro-settings__notice micro-settings__notice--error";
      connection.append(error);
    }
    root.append(connection);

    const lighting = element("section");
    lighting.className = "micro-card";
    lighting.append(element("h2", "Lighting"));
    const brightness = element("input");
    brightness.type = "range";
    brightness.min = "0";
    brightness.max = "100";
    brightness.step = "1";
    brightness.value = String(currentSnapshot.preferences.brightness);
    brightness.setAttribute("aria-label", "Brightness");
    const brightnessValue = element("output", `${brightness.value}%`);
    brightness.addEventListener("input", () => {
      brightnessValue.textContent = `${brightness.value}%`;
    });
    brightness.addEventListener("change", () => {
      const next = clonePreferences(currentSnapshot.preferences);
      next.brightness = Number(brightness.value);
      void controller.updatePreferences(next);
    });
    const brightnessField = field("Brightness", brightness);
    brightnessField.append(brightnessValue);
    lighting.append(brightnessField);
    lighting.append(
      field(
        "Auto-dim",
        selectControl(autoDimOptions, currentSnapshot.preferences.autoDim, (autoDim) => {
          const next = clonePreferences(currentSnapshot.preferences);
          next.autoDim = autoDim;
          void controller.updatePreferences(next);
        }),
      ),
    );
    pauseControls(lighting, currentSnapshot.preferencesReady);
    root.append(lighting);

    const behavior = element("section");
    behavior.className = "micro-card";
    behavior.append(element("h2", "Input behavior"));
    const agentSourceOptions = [
      ["recent", "Recent sessions"],
      ["pinned", "Pinned sessions"],
      ["priority", "Priority: error, approval, input, working, unread"],
      ["custom", "Custom slots"],
    ] as const;
    behavior.append(
      field(
        "Agent source",
        selectControl(
          agentSourceOptions,
          currentSnapshot.preferences.agentSource,
          (agentSource) => {
            const next = clonePreferences(currentSnapshot.preferences);
            next.agentSource = agentSource;
            void controller.updatePreferences(next);
          },
        ),
      ),
    );
    behavior.append(
      field(
        "Encoder",
        selectControl(
          [
            ["composer-navigation", "Composer navigation"],
            ["reasoning", "Reasoning only"],
          ] as const,
          currentSnapshot.preferences.encoderMode,
          (encoderMode) => {
            const next = clonePreferences(currentSnapshot.preferences);
            next.encoderMode = encoderMode;
            void controller.updatePreferences(next);
          },
        ),
      ),
    );
    behavior.append(
      field(
        "Microphone",
        selectControl(
          [
            ["push-to-talk", "Push to talk"],
            ["toggle-dictation", "Toggle dictation"],
          ] as const,
          currentSnapshot.preferences.microphoneMode,
          (microphoneMode) => {
            const next = clonePreferences(currentSnapshot.preferences);
            next.microphoneMode = microphoneMode;
            void controller.updatePreferences(next);
          },
        ),
      ),
    );
    behavior.append(
      field(
        "Separate microphone switches",
        toggleControl(currentSnapshot.preferences.separateMicrophoneKeys, (checked) => {
          const next = clonePreferences(currentSnapshot.preferences);
          next.separateMicrophoneKeys = checked;
          void controller.updatePreferences(next);
        }),
      ),
    );
    behavior.append(
      field(
        "Focus the Control UI window on a single tap",
        toggleControl(currentSnapshot.preferences.focusSingleTap, (checked) => {
          const next = clonePreferences(currentSnapshot.preferences);
          next.focusSingleTap = checked;
          void controller.updatePreferences(next);
        }),
      ),
    );
    if (currentSnapshot.preferences.agentSource === "custom") {
      const slots = element("div");
      slots.className = "micro-settings__grid";
      for (let index = 0; index < 6; index++) {
        const options = [
          ["", "Empty slot"],
          ...currentSnapshot.sessions.map((session) => [session.key, session.title] as const),
        ] as const;
        slots.append(
          field(
            `AG0${index}`,
            selectControl(
              options,
              currentSnapshot.preferences.customSessionKeys[index] ?? "",
              (key) => {
                const next = clonePreferences(currentSnapshot.preferences);
                next.customSessionKeys[index] = key || null;
                void controller.updatePreferences(next);
              },
            ),
          ),
        );
      }
      behavior.append(slots);
    }
    pauseControls(behavior, currentSnapshot.preferencesReady);
    root.append(behavior);

    const layout = element("section");
    layout.className = "micro-card";
    const layoutHeader = element("div");
    layoutHeader.className = "micro-settings__section-header";
    layoutHeader.append(element("h2", "Layout editor"));
    const reset = element("button", "Reset layout");
    reset.type = "button";
    reset.disabled = !currentSnapshot.connected || !currentSnapshot.canWrite;
    reset.addEventListener("click", () => {
      const next = clonePreferences(currentSnapshot.preferences);
      const defaults = defaultMicroPreferences();
      next.bindings = defaults.bindings;
      next.customSessionKeys = defaults.customSessionKeys;
      void controller.updatePreferences(next);
    });
    layoutHeader.append(reset);
    layout.append(layoutHeader);
    const rows = element("div");
    rows.className = "micro-layout-editor";
    for (const [key, label] of bindingRows) {
      const current: MicroBinding = currentSnapshot.preferences.bindings[key] ?? {
        type: "none",
        value: "",
        label,
      };
      const row = element("div");
      row.className = "micro-layout-editor__row";
      row.append(element("strong", label));
      const type = selectControl(
        [
          ["command", "Command"],
          ["text", "Text"],
          ["skill", "Skill"],
          ["url", "URL"],
          ["none", "None"],
        ] as const,
        current.type,
        (bindingType) => {
          const next = clonePreferences(currentSnapshot.preferences);
          const existing = next.bindings[key] ?? current;
          next.bindings[key] = { ...existing, type: bindingType };
          void controller.updatePreferences(next);
        },
      );
      type.setAttribute("aria-label", `${label} binding type`);
      row.append(type);
      if (current.type === "command") {
        const value = selectControl(commandOptions, current.value, (command) => {
          const next = clonePreferences(currentSnapshot.preferences);
          next.bindings[key] = { ...current, value: command };
          void controller.updatePreferences(next);
        });
        value.setAttribute("aria-label", `${label} command`);
        row.append(value);
      } else if (current.type !== "none") {
        const value = element("input");
        value.type = "text";
        value.value = current.value;
        value.placeholder =
          current.type === "text" ? "Text to place in the composer" : current.type;
        value.setAttribute("aria-label", `${label} ${current.type} value`);
        value.addEventListener("change", () => {
          const next = clonePreferences(currentSnapshot.preferences);
          next.bindings[key] = { ...current, value: value.value };
          void controller.updatePreferences(next);
        });
        row.append(value);
      } else {
        row.append(element("span", "No action"));
      }
      const labelInput = element("input");
      labelInput.type = "text";
      labelInput.maxLength = 128;
      labelInput.value = current.label;
      labelInput.setAttribute("aria-label", `${label} display label`);
      labelInput.addEventListener("change", () => {
        const next = clonePreferences(currentSnapshot.preferences);
        next.bindings[key] = { ...current, label: labelInput.value };
        void controller.updatePreferences(next);
      });
      row.append(labelInput);
      rows.append(row);
    }
    layout.append(rows);
    pauseControls(layout, currentSnapshot.preferencesReady);
    root.append(layout);

    const actions = element("nav");
    actions.className = "micro-settings__shortcuts";
    actions.setAttribute("aria-label", "Open Control UI pages");
    for (const [route, label] of [
      ["settings", "Settings"],
      ["files", "Files"],
      ["skills", "Skills"],
    ] as const) {
      const button = element("button", label);
      button.type = "button";
      button.addEventListener("click", () => controller.openRoute(route));
      actions.append(button);
    }
    root.append(actions);

    const message = currentSnapshot.error ?? currentSnapshot.receipt;
    if (message) {
      const status = element("p", message);
      status.className = `micro-settings__notice${currentSnapshot.error ? " micro-settings__notice--error" : ""}`;
      status.setAttribute("role", currentSnapshot.error ? "alert" : "status");
      root.append(status);
    }
    container.replaceChildren(root);
  };

  const unsubscribe = controller.subscribe(render);
  render();
  return {
    dispose() {
      unsubscribe();
      container.replaceChildren();
    },
  };
}

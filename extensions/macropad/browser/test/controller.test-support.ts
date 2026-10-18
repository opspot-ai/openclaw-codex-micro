import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";
import { defaultMicroPreferences, type MicroInput, type MicroPreferences } from "../../contract.js";
import { MicroBrowserController } from "../controller.js";

export const sessions: ControlUiSession[] = [
  { key: "agent:main:first", agentId: "main", displayName: "First" } as unknown as ControlUiSession,
  {
    key: "agent:main:second",
    agentId: "main",
    displayName: "Second",
  } as unknown as ControlUiSession,
];

export function createHost(
  options: {
    preferences?: MicroPreferences;
    createSession?: () => Promise<string | null>;
    forkSession?: () => Promise<unknown>;
    sessions?: ControlUiSession[];
    skillsStatus?: unknown;
    commands?: unknown;
    openExternal?: (url: string) => Promise<boolean>;
    generation?: number;
    connectionId?: string;
    readPreferences?: () => Promise<MicroPreferences>;
    execApprovals?: unknown[];
    pluginApprovals?: unknown[];
    systemAgentApprovals?: unknown[];
    systemAgentApprovalResolution?: unknown;
    legacyApprovalResolution?: unknown;
    deviceConnected?: boolean;
  } = {},
) {
  const signal = new AbortController().signal;
  const connection = {
    connected: true,
    generation: options.generation,
    id: options.connectionId ?? "connection-test",
    canRead: true,
    canWrite: true,
    canGrant: true,
    canAdmin: false,
    assistantAgentId: "main",
  };
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const subscribers = new Set<() => void>();
  const featureOperations: Array<{ actionId: string; payload: Record<string, unknown> }> = [];
  const directRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const openedSessions: Array<Record<string, unknown>> = [];
  const replacements = new Map<string, { mount: (container: HTMLElement, context: any) => any }>();
  const focused = vi.fn(async () => true);
  const preferences = options.preferences ?? defaultMicroPreferences();
  const hostSessions = [...(options.sessions ?? sessions)];
  const createSession = vi.fn(options.createSession ?? (async () => "agent:main:new"));
  const receiptWaiters: Array<{ count: number; resolve: () => void }> = [];
  const preferencesReadWaiters: Array<{ count: number; resolve: () => void }> = [];
  const uiSyncWaiters: Array<{ state: string; afterCount: number; resolve: () => void }> = [];
  let preferencesReadCount = 0;
  let deviceConnected = options.deviceConnected ?? false;
  let receiptOk = true;
  const sessionSnapshot = { result: { sessions: hostSessions }, loading: false, error: null };
  const host = {
    apiVersion: 1,
    pluginId: "macropad",
    signal,
    basePath: "",
    locale: "en",
    redact: (value: string) => value,
    connection,
    components: {},
    window: { focus: focused },
    links: { openExternal: options.openExternal ?? vi.fn(async () => true) },
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "plugins.sessionAction") {
        const actionId = String(params?.actionId);
        const payload = (params?.payload ?? {}) as Record<string, unknown>;
        featureOperations.push({ actionId, payload });
        if (actionId === "ui.sync") {
          const syncs = featureOperations.filter(({ actionId: id }) => id === "ui.sync");
          for (const waiter of uiSyncWaiters.splice(0)) {
            if (
              syncs
                .slice(waiter.afterCount)
                .some(({ payload: sync }) => sync.voiceState === waiter.state)
            ) {
              waiter.resolve();
            } else {
              uiSyncWaiters.push(waiter);
            }
          }
        }
        if (actionId === "device.get") {
          return {
            ok: true,
            result: {
              connected: deviceConnected,
              product: deviceConnected ? "Codex Micro" : null,
              firmware: null,
              transport: deviceConnected ? "USB" : null,
              battery: null,
              charging: false,
              inputPermission: "unknown",
              error: null,
              inputCount: 0,
              dimmed: false,
            },
          };
        }
        if (actionId === "preferences.get") {
          preferencesReadCount += 1;
          for (const waiter of preferencesReadWaiters.splice(0)) {
            if (preferencesReadCount >= waiter.count) {
              waiter.resolve();
            } else {
              preferencesReadWaiters.push(waiter);
            }
          }
          if (options.readPreferences) {
            return { ok: true, result: await options.readPreferences() };
          }
          return { ok: true, result: preferences };
        }
        if (actionId === "preferences.set") {
          return { ok: true, result: payload };
        }
        if (actionId === "ui.result") {
          for (const waiter of receiptWaiters.splice(0)) {
            if (
              featureOperations.filter(({ actionId: id }) => id === "ui.result").length >=
              waiter.count
            ) {
              waiter.resolve();
            } else {
              receiptWaiters.push(waiter);
            }
          }
          return { ok: true, result: { ok: receiptOk } };
        }
        return { ok: true, result: { ok: true } };
      }
      directRequests.push({ method, params });
      if (method === "question.list") {
        return { questions: [] };
      }
      if (method === "exec.approval.list") {
        return options.execApprovals ?? [];
      }
      if (method === "plugin.approval.list") {
        return options.pluginApprovals ?? [];
      }
      if (method === "openclaw.approval.list") {
        return options.systemAgentApprovals ?? [];
      }
      if (method === "approval.resolve") {
        return (
          options.systemAgentApprovalResolution ?? {
            applied: true,
            approval: { decision: params?.decision },
          }
        );
      }
      if (method === "exec.approval.resolve" || method === "plugin.approval.resolve") {
        return options.legacyApprovalResolution ?? { ok: true };
      }
      if (method === "skills.status") {
        return options.skillsStatus ?? { skills: [] };
      }
      if (method === "commands.list") {
        return options.commands ?? { commands: [] };
      }
      if (method === "sessions.describe") {
        const session = hostSessions.find((row) => row.key === params?.key);
        return session ? { session } : { session: null };
      }
      if (method === "sessions.create") {
        return options.forkSession
          ? await options.forkSession()
          : { ok: true, key: "agent:main:forked" };
      }
      if (method === "sessions.patch" && typeof params?.planMode === "boolean") {
        const session = hostSessions.find((row) => row.key === params.key) as
          | (ControlUiSession & { planMode?: boolean })
          | undefined;
        if (session) {
          session.planMode = params.planMode;
        }
        return { ok: true };
      }
      return [];
    },
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      const listeners = eventListeners.get(event) ?? new Set();
      listeners.add(listener);
      eventListeners.set(event, listeners);
      return () => listeners.delete(listener);
    },
    emitEvent: (event: string, payload: unknown) => {
      for (const listener of eventListeners.get(event) ?? []) {
        listener(payload);
      }
    },
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    notify: () => {
      for (const listener of subscribers) {
        listener();
      }
    },
    sessions: {
      rows: hostSessions,
      selectedKey: "agent:main:first",
      normalizeKey: (key: string) => key.toLowerCase(),
      refresh: async () => undefined,
      observe: (_query: unknown, listener: (snapshot: typeof sessionSnapshot) => void) => {
        listener(sessionSnapshot);
        return { refresh: async () => listener(sessionSnapshot), dispose: () => undefined };
      },
      open: (target: Record<string, unknown>) => openedSessions.push(target),
      create: createSession,
      patch: async () => undefined,
    },
    agents: {
      rows: [],
      selectedId: "main",
      defaultId: "main",
      scopeId: null,
      select: () => undefined,
      setScope: () => undefined,
      refresh: async () => undefined,
    },
    navigation: { openPage: vi.fn(), pageHref: () => "/" },
    ui: {
      invalidate: () => undefined,
      registerPage: () => () => undefined,
      registerNavigation: () => () => undefined,
      pinNavigation: () => undefined,
      registerPanel: () => () => undefined,
      openPanel: () => undefined,
      registerAction: () => () => undefined,
      registerAccessory: () => () => undefined,
      registerWidget: () => () => undefined,
      registerReplacement: (replacement: {
        surface: string;
        mount: (container: HTMLElement, context: any) => any;
      }) => {
        replacements.set(replacement.surface, replacement);
        return () => replacements.delete(replacement.surface);
      },
      selectReplacement: () => undefined,
    },
  };
  return {
    host: host as unknown as ControlUiHost,
    connection,
    featureOperations,
    directRequests,
    openedSessions,
    createSession,
    replacements,
    focused,
    setReceiptOk(value: boolean) {
      receiptOk = value;
    },
    emitInput(input: Omit<MicroInput, "connectionId"> & { connectionId?: string }) {
      host.emitEvent("plugin.macropad.input", {
        ...input,
        connectionId: input.connectionId ?? connection.id,
      });
    },
    emitDevice(connected: boolean) {
      deviceConnected = connected;
      host.emitEvent("plugin.macropad.device_changed", {
        connected,
        product: connected ? "Codex Micro" : null,
        firmware: null,
        transport: connected ? "USB" : null,
        battery: null,
        charging: false,
        inputPermission: "granted",
        error: null,
        inputCount: 0,
        dimmed: false,
      });
    },
    emitPreferences(next: MicroPreferences) {
      host.emitEvent("plugin.macropad.preferences_changed", next);
    },
    waitForReceiptCount(count: number) {
      if (featureOperations.filter(({ actionId }) => actionId === "ui.result").length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        receiptWaiters.push({ count, resolve });
      });
    },
    waitForPreferencesReadCount(count: number) {
      if (preferencesReadCount >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        preferencesReadWaiters.push({ count, resolve });
      });
    },
    uiSyncCount() {
      return featureOperations.filter(({ actionId }) => actionId === "ui.sync").length;
    },
    latestUiSyncVoiceState() {
      return featureOperations.findLast(({ actionId }) => actionId === "ui.sync")?.payload
        .voiceState;
    },
    waitForUiSyncState(state: string, afterCount = 0) {
      const matches = () =>
        featureOperations
          .filter(({ actionId }) => actionId === "ui.sync")
          .slice(afterCount)
          .some(({ payload }) => payload.voiceState === state);
      if (matches()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        uiSyncWaiters.push({ state, afterCount, resolve });
      });
    },
    notify: host.notify,
  };
}

export async function flushActions(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
  }
}

export async function waitForPreferences(controller: MicroBrowserController): Promise<void> {
  if (controller.preferencesReady) {
    return;
  }
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => {};
    const check = () => {
      if (!controller.preferencesReady) {
        return;
      }
      unsubscribe();
      resolve();
    };
    unsubscribe = controller.subscribe(check);
    check();
  });
}

export async function waitForReceiptMessage(
  controller: MicroBrowserController,
  phrase: string,
): Promise<void> {
  if (controller.snapshot().receipt?.includes(phrase)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => {};
    const check = () => {
      if (!controller.snapshot().receipt?.includes(phrase)) {
        return;
      }
      unsubscribe();
      resolve();
    };
    unsubscribe = controller.subscribe(check);
    check();
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

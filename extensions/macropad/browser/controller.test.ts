import type { ControlUiSession } from "openclaw/plugin-sdk/control-ui";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMicroPreferences, type MicroInput, type MicroPreferences } from "../contract.js";
import { MicroBrowserController } from "./controller.js";
import {
  createHost,
  deferred,
  flushActions,
  waitForPreferences,
  waitForReceiptMessage,
} from "./test/controller.test-support.js";

describe("Codex Micro Control UI controller", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("does not run default actions while saved preferences are still loading", async () => {
    const savedPreferences = deferred<MicroPreferences>();
    const harness = createHost({ readPreferences: () => savedPreferences.promise });
    const controller = new MicroBrowserController(harness.host);
    controller.start();

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });

    expect(controller.preferencesReady).toBe(false);
    expect(controller.snapshot().error).toContain("physical input was not executed");
    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toEqual([]);

    savedPreferences.resolve(defaultMicroPreferences());
    await waitForPreferences(controller);
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 2,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toHaveLength(
      1,
    );
    expect(
      harness.featureOperations
        .filter(({ actionId }) => actionId === "ui.result")
        .map(({ payload }) => payload.sequence),
    ).toEqual([2]);
    controller.dispose();
  });

  it("reloads preferences for a replacement socket and ignores the old query result", async () => {
    const oldRead = deferred<MicroPreferences>();
    const currentRead = deferred<MicroPreferences>();
    let readIndex = 0;
    const stale = defaultMicroPreferences();
    const fresh = defaultMicroPreferences();
    fresh.bindings.ACT06 = { type: "none", value: "", label: "No action" };
    const harness = createHost({
      generation: 1,
      readPreferences: () => (++readIndex === 1 ? oldRead.promise : currentRead.promise),
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await harness.waitForPreferencesReadCount(1);

    harness.connection.generation = 2;
    harness.notify();
    await harness.waitForPreferencesReadCount(2);

    oldRead.resolve(stale);
    await flushActions();
    expect(controller.preferencesReady).toBe(false);

    currentRead.resolve(fresh);
    await waitForPreferences(controller);
    expect(controller.snapshot().preferences.bindings.ACT06).toEqual(fresh.bindings.ACT06);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);
    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toEqual([]);
    controller.dispose();
  });

  it("opens the session captured at key-down and uses the native focus capability for a double tap", async () => {
    const harness = createHost();
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "AG00",
      act: 1,
      sessionKey: "agent:main:first",
    });
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 2,
      kind: "key",
      key: "AG00",
      act: 0,
      sessionKey: "agent:main:second",
    });
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 3,
      kind: "key",
      key: "AG00",
      act: 1,
      sessionKey: "agent:main:first",
    });
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 4,
      kind: "key",
      key: "AG00",
      act: 0,
      sessionKey: "agent:main:second",
    });
    await harness.waitForReceiptCount(2);

    expect(harness.openedSessions).toEqual([
      { sessionKey: "agent:main:first", agentId: "main" },
      { sessionKey: "agent:main:first", agentId: "main" },
    ]);
    expect(harness.focused).toHaveBeenCalledOnce();
    expect(
      harness.featureOperations.filter(({ actionId }) => actionId === "ui.result"),
    ).toHaveLength(2);
    controller.dispose();
  });

  it("creates and assigns a new session to the captured empty custom slot", async () => {
    const preferences = defaultMicroPreferences();
    preferences.agentSource = "custom";
    const harness = createHost({ preferences });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "AG03",
      act: 1,
      sessionKey: null,
    });
    await harness.waitForReceiptCount(1);

    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(harness.createSession).toHaveBeenCalledWith({ agentId: "main" });
    const saved = harness.featureOperations.find(
      ({ actionId }) => actionId === "preferences.set",
    )?.payload;
    expect(saved?.customSessionKeys).toEqual([null, null, null, "agent:main:new", null, null]);
    expect(controller.snapshot().preferences.customSessionKeys[3]).toBe("agent:main:new");
    expect(harness.openedSessions).toContainEqual({
      sessionKey: "agent:main:new",
      agentId: "main",
    });
    expect(controller.snapshot().receipt).toContain("assigned a new session to AG03");
    controller.dispose();
  });

  it("leaves a newly created session unassigned when the custom slot changes during creation", async () => {
    const creation = deferred<string | null>();
    const creationStarted = deferred<void>();
    const preferences = defaultMicroPreferences();
    preferences.agentSource = "custom";
    const harness = createHost({
      preferences,
      createSession: () => {
        creationStarted.resolve();
        return creation.promise;
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "AG04",
      act: 1,
      sessionKey: null,
    });
    await creationStarted.promise;
    const changed = controller.snapshot().preferences;
    const next: MicroPreferences = {
      ...changed,
      customSessionKeys: [...changed.customSessionKeys],
    };
    next.customSessionKeys[4] = "agent:main:manual";
    expect(await controller.updatePreferences(next)).toBe(true);

    creation.resolve("agent:main:created");
    await harness.waitForReceiptCount(1);

    const writes = harness.featureOperations
      .filter(({ actionId }) => actionId === "preferences.set")
      .map(({ payload }) => payload.customSessionKeys);
    expect(writes).toEqual([[null, null, null, null, "agent:main:manual", null]]);
    expect(controller.snapshot().preferences.customSessionKeys[4]).toBe("agent:main:manual");
    expect(harness.openedSessions).toContainEqual({
      sessionKey: "agent:main:created",
      agentId: "main",
    });
    expect(controller.snapshot().receipt).toContain("created and opened");
    expect(controller.snapshot().receipt).toContain("AG04");
    controller.dispose();
  });

  it("does not assign or replay a custom-slot creation across reconnect", async () => {
    const creation = deferred<string | null>();
    const creationStarted = deferred<void>();
    const preferences = defaultMicroPreferences();
    preferences.agentSource = "custom";
    const harness = createHost({
      preferences,
      createSession: () => {
        creationStarted.resolve();
        return creation.promise;
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "AG05",
      act: 1,
      sessionKey: null,
    });
    await creationStarted.promise;
    harness.connection.connected = false;
    harness.notify();
    harness.connection.connected = true;
    harness.notify();
    creation.resolve("agent:main:after-reconnect");
    await waitForReceiptMessage(
      controller,
      "A new session was created, but AG05 could not be assigned",
    );

    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(
      harness.featureOperations.filter(({ actionId }) => actionId === "preferences.set"),
    ).toEqual([]);
    expect(harness.openedSessions).toEqual([]);
    expect(controller.snapshot().receipt).toContain(
      "A new session was created, but AG05 could not be assigned",
    );
    controller.dispose();
  });

  it("does not open or replay a captured fork after the socket changes during creation", async () => {
    const forkResult = deferred<unknown>();
    const forkStarted = deferred<void>();
    const harness = createHost({
      forkSession: () => {
        forkStarted.resolve();
        return forkResult.promise;
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT09",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await forkStarted.promise;
    harness.connection.id = "connection-replaced";
    harness.notify();
    await waitForPreferences(controller);
    forkResult.resolve({ ok: true, key: "agent:main:forked" });
    await flushActions();

    expect(
      harness.directRequests.filter(({ method }) => method === "sessions.create"),
    ).toHaveLength(1);
    expect(
      harness.directRequests.find(({ method }) => method === "sessions.create")?.params,
    ).toMatchObject({
      parentSessionKey: "agent:main:first",
      fork: true,
    });
    expect(harness.openedSessions).toEqual([]);
    expect(harness.featureOperations.filter(({ actionId }) => actionId === "ui.result")).toEqual(
      [],
    );
    controller.dispose();
  });

  it("accepts a fresh sequence after socket replacement and skips the old queued action", async () => {
    const harness = createHost({ generation: 1 });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 900,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    harness.connection.generation = 2;
    harness.notify();
    await waitForPreferences(controller);
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    const patches = harness.directRequests.filter(({ method }) => method === "sessions.patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.params).toMatchObject({ key: "agent:main:first", fastMode: true });
    expect(
      harness.featureOperations
        .filter(({ actionId }) => actionId === "ui.result")
        .map(({ payload }) => payload.sequence),
    ).toEqual([1]);
    controller.dispose();
  });

  it("rejects another connection's broadcast before sequence tracking or action execution", async () => {
    const harness = createHost();
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      connectionId: "connection-other",
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await flushActions();

    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toEqual([]);
    expect(harness.featureOperations.filter(({ actionId }) => actionId === "ui.result")).toEqual(
      [],
    );

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toHaveLength(
      1,
    );
    expect(
      harness.featureOperations.filter(({ actionId }) => actionId === "ui.result"),
    ).toHaveLength(1);

    Object.assign(harness.connection, { id: undefined });
    harness.emitInput({
      clientId: controller.clientId,
      connectionId: "connection-test",
      sequence: 2,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await flushActions();
    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toHaveLength(
      1,
    );
    expect(
      harness.featureOperations.filter(({ actionId }) => actionId === "ui.result"),
    ).toHaveLength(1);
    controller.dispose();
  });

  it("inserts an eligible skill through the captured native composer without sending it", async () => {
    const preferences = defaultMicroPreferences();
    preferences.bindings.ACT06 = { type: "skill", value: "summarize", label: "Summarize" };
    const harness = createHost({
      preferences,
      skillsStatus: {
        skills: [
          {
            name: "Summarize",
            skillKey: "summarize",
            disabled: false,
            blockedByAllowlist: false,
            blockedByAgentFilter: false,
            modelVisible: true,
            missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
          },
        ],
      },
      commands: {
        commands: [
          {
            name: "summarize_skill",
            nativeName: "summarize_skill",
            textAliases: ["/summarize_skill"],
            skillDisplayName: "Summarize",
            skillModelVisible: true,
            source: "skill",
          },
        ],
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    const container = document.createElement("div");
    const textarea = document.createElement("textarea");
    textarea.value = "Please $sum";
    textarea.selectionStart = textarea.value.length;
    container.append(textarea);
    const setDraft = vi.fn();
    controller.setComposer(
      {
        sessionKey: "agent:main:first",
        agentId: "main",
        draft: textarea.value,
        canSend: true,
        sending: false,
        disabledReason: null,
        setDraft,
        send: vi.fn(async () => false),
      } as never,
      container,
      {},
    );

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(harness.directRequests).toContainEqual({
      method: "skills.status",
      params: { agentId: "main" },
    });
    expect(harness.directRequests).toContainEqual({
      method: "commands.list",
      params: { agentId: "main", sessionKey: "agent:main:first", includeArgs: true, scope: "text" },
    });
    expect(setDraft).toHaveBeenCalledWith("Please $summarize_skill ");
    expect(harness.directRequests.some(({ method }) => method === "chat.send")).toBe(false);
    expect(controller.snapshot().receipt).toContain("was not sent");
    controller.dispose();
  });

  it.each([
    ["disabled", { disabled: true }],
    [
      "missing dependencies",
      { missing: { anyBins: ["tool"], bins: [], env: [], config: [], os: [] } },
    ],
    ["agent allowlist", { blockedByAllowlist: true }],
    ["agent filter", { blockedByAgentFilter: true }],
  ])(
    "refuses a skill binding when the native status marks it unavailable: %s",
    async (_label, override) => {
      const preferences = defaultMicroPreferences();
      preferences.bindings.ACT06 = { type: "skill", value: "summarize", label: "Summarize" };
      const harness = createHost({
        preferences,
        skillsStatus: {
          skills: [
            {
              name: "summarize",
              skillKey: "summarize",
              disabled: false,
              blockedByAllowlist: false,
              blockedByAgentFilter: false,
              modelVisible: true,
              missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
              ...override,
            },
          ],
        },
      });
      const controller = new MicroBrowserController(harness.host);
      controller.start();
      await waitForPreferences(controller);
      const container = document.createElement("div");
      const textarea = document.createElement("textarea");
      container.append(textarea);
      const setDraft = vi.fn();
      controller.setComposer(
        {
          sessionKey: "agent:main:first",
          agentId: "main",
          draft: "",
          canSend: true,
          sending: false,
          disabledReason: null,
          setDraft,
          send: vi.fn(async () => false),
        } as never,
        container,
        {},
      );
      harness.emitInput({
        clientId: controller.clientId,
        sequence: 1,
        kind: "key",
        key: "ACT06",
        act: 1,
        sessionKey: "agent:main:first",
      });
      await harness.waitForReceiptCount(1);

      expect(setDraft).not.toHaveBeenCalled();
      expect(
        harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload.ok,
      ).toBe(false);
      controller.dispose();
    },
  );

  it("drops duplicate sequences but processes each distinct physical action once", async () => {
    const harness = createHost();
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    const down: MicroInput = {
      clientId: controller.clientId,
      connectionId: "connection-test",
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    };
    harness.emitInput(down);
    harness.emitInput(down);
    harness.emitInput({ ...down, sequence: 2, act: 0 });
    harness.emitInput({ ...down, sequence: 3, act: 1 });
    harness.emitInput({ ...down, sequence: 4, act: 0 });
    await harness.waitForReceiptCount(2);

    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toHaveLength(
      2,
    );
    expect(
      harness.featureOperations
        .filter(({ actionId }) => actionId === "ui.result")
        .map(({ payload }) => payload.sequence),
    ).toEqual([1, 3]);
    controller.dispose();
  });

  it("checks the current grant scope before resolving an approval", async () => {
    const harness = createHost();
    harness.connection.canGrant = false;
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(
      harness.directRequests.filter(({ method }) => method.endsWith("approval.resolve")),
    ).toEqual([]);
    expect(controller.snapshot().error).toContain("does not have approval access");
    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload.ok,
    ).toBe(false);
    controller.dispose();
  });

  it.each([
    {
      kind: "exec" as const,
      resolveMethod: "exec.approval.resolve",
      listOptions: {
        execApprovals: [
          {
            id: "other-session",
            sourceSessionKey: "agent:main:second",
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            status: "pending",
          },
          {
            id: "captured-exec",
            request: { sessionKey: "AGENT:MAIN:FIRST" },
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            status: "pending",
          },
        ],
      },
    },
    {
      kind: "plugin" as const,
      resolveMethod: "plugin.approval.resolve",
      listOptions: {
        pluginApprovals: [
          {
            id: "other-session",
            sourceSessionKey: "agent:main:second",
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            status: "pending",
          },
          {
            id: "captured-plugin",
            sourceSessionKey: "AGENT:MAIN:FIRST",
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            status: "pending",
          },
        ],
      },
    },
  ])(
    "resolves only the normalized captured-session match for legacy $kind approvals",
    async ({ resolveMethod, listOptions }) => {
      const harness = createHost(listOptions);
      const controller = new MicroBrowserController(harness.host);
      controller.start();
      await waitForPreferences(controller);

      harness.emitInput({
        clientId: controller.clientId,
        sequence: 1,
        kind: "key",
        key: "ACT07",
        act: 1,
        sessionKey: "agent:main:FIRST",
      });
      await harness.waitForReceiptCount(1);

      const resolutions = harness.directRequests.filter(({ method }) =>
        method.endsWith("approval.resolve"),
      );
      const approvalId = resolveMethod.startsWith("exec") ? "captured-exec" : "captured-plugin";
      expect(resolutions).toEqual([
        { method: resolveMethod, params: { id: approvalId, decision: "allow-once" } },
      ]);
      expect(
        harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
      ).toMatchObject({
        ok: true,
        message: "Approved the matching request once.",
      });
      controller.dispose();
    },
  );

  it("fails closed when more than one approval matches the captured conversation", async () => {
    const expiresAtMs = Date.now() + 60_000;
    const harness = createHost({
      execApprovals: [{ id: "exec-match", sourceSessionKey: "agent:main:first", expiresAtMs }],
      pluginApprovals: [{ id: "plugin-match", sourceSessionKey: "AGENT:MAIN:FIRST", expiresAtMs }],
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(
      harness.directRequests.filter(({ method }) => method.endsWith("approval.resolve")),
    ).toEqual([]);
    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("Several pending approvals"),
    });
    controller.dispose();
  });

  it("rejects a system-agent approval result that was already terminal", async () => {
    const harness = createHost({
      systemAgentApprovals: [
        {
          id: "system-target",
          sourceSessionKey: "agent:main:first",
          expiresAtMs: Date.now() + 60_000,
          status: "pending",
        },
      ],
      systemAgentApprovalResolution: {
        applied: false,
        approval: { status: "allowed", decision: "allow-once" },
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(harness.directRequests).toContainEqual({
      method: "approval.resolve",
      params: { id: "system-target", kind: "system-agent", decision: "allow-once" },
    });
    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not apply a new decision"),
    });
    controller.dispose();
  });

  it("rejects a system-agent approval result when decision readback differs", async () => {
    const harness = createHost({
      systemAgentApprovals: [
        {
          id: "system-target",
          sourceSessionKey: "agent:main:first",
          expiresAtMs: Date.now() + 60_000,
          status: "pending",
        },
      ],
      systemAgentApprovalResolution: {
        applied: true,
        approval: { status: "allowed", decision: "deny" },
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("different decision"),
    });
    controller.dispose();
  });

  it("accepts a newly applied system-agent approval with matching decision readback", async () => {
    const harness = createHost({
      systemAgentApprovals: [
        {
          id: "system-target",
          sourceSessionKey: "agent:main:first",
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          status: "pending",
        },
      ],
      systemAgentApprovalResolution: {
        applied: true,
        approval: { status: "allowed", decision: "allow-once" },
      },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
    ).toMatchObject({
      ok: true,
      message: "Approved the matching request once.",
    });
    controller.dispose();
  });

  it("requires ok:true from legacy approval resolution responses", async () => {
    const harness = createHost({
      execApprovals: [
        {
          id: "exec-target",
          sourceSessionKey: "agent:main:first",
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      legacyApprovalResolution: { ok: false },
    });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT07",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(
      harness.featureOperations.find(({ actionId }) => actionId === "ui.result")?.payload,
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not confirm"),
    });
    controller.dispose();
  });

  it("shows a rejected receipt locally without repeating the completed action", async () => {
    const harness = createHost();
    harness.setReceiptOk(false);
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await waitForReceiptMessage(controller, "device rejected its receipt");

    expect(harness.directRequests.filter(({ method }) => method === "sessions.patch")).toHaveLength(
      1,
    );
    expect(
      harness.featureOperations.filter(({ actionId }) => actionId === "ui.result"),
    ).toHaveLength(1);
    expect(controller.snapshot().receipt).toContain("device rejected its receipt");
    controller.dispose();
  });

  it("toggles Plan mode with session and mode compare-and-set, then renders verified readback", async () => {
    const sessionRows = [
      {
        key: "agent:main:first",
        agentId: "main",
        planMode: false,
      },
    ] as unknown as ControlUiSession[];
    const harness = createHost({ sessions: sessionRows });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    const composerContainer = document.createElement("div");
    controller.setComposer(
      {
        sessionKey: "agent:main:first",
        agentId: "main",
        draft: "",
        canSend: false,
        sending: false,
        disabledReason: null,
        setDraft: vi.fn(),
        send: vi.fn(async () => false),
      } as never,
      composerContainer,
      {},
    );
    expect(controller.snapshot().planMode).toBe(false);

    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "radial",
      angle: 0.75,
      distance: 0.8,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(harness.directRequests).toContainEqual({
      method: "sessions.patch",
      params: {
        key: "agent:main:first",
        agentId: "main",
        planMode: true,
        expectedPlanMode: false,
      },
    });
    expect(harness.directRequests.some(({ method }) => method === "sessions.describe")).toBe(true);
    expect(controller.snapshot().planMode).toBe(true);
    expect(controller.snapshot().receipt).toContain("verified from session readback");
    controller.dispose();
  });

  it("requests configured URL bindings through the host external-link policy", async () => {
    const preferences = defaultMicroPreferences();
    preferences.bindings.ACT06 = { type: "url", value: "https://example.com/path", label: "Docs" };
    const openExternal = vi.fn(async () => true);
    const harness = createHost({ preferences, openExternal });
    const controller = new MicroBrowserController(harness.host);
    controller.start();
    await waitForPreferences(controller);
    harness.emitInput({
      clientId: controller.clientId,
      sequence: 1,
      kind: "key",
      key: "ACT06",
      act: 1,
      sessionKey: "agent:main:first",
    });
    await harness.waitForReceiptCount(1);

    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
    expect(controller.snapshot().receipt).toContain("page visibility is not verified");
    controller.dispose();
  });
});

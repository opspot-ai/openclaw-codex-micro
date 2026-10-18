import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type, type Static } from "typebox";

const MACROPAD_PLUGIN_ID = "macropad";
const SlotStatusSchema = Type.Enum({
  off: "off",
  idle: "idle",
  working: "working",
  unread: "unread",
  approval: "awaiting-approval",
  response: "awaiting-response",
  error: "error",
} as const);
export type SlotStatus =
  | "off"
  | "idle"
  | "working"
  | "unread"
  | "awaiting-approval"
  | "awaiting-response"
  | "error";
const SlotSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 0, maximum: 5 }),
    sessionKey: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    agentId: Type.Optional(Type.String({ maxLength: 128 })),
    title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
    status: SlotStatusSchema,
    selected: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MicroSlot = Omit<Static<typeof SlotSchema>, "status"> & { status: SlotStatus };
const SlotsSchema = Type.Array(SlotSchema, { minItems: 6, maxItems: 6 });
const BindingSchema = Type.Object(
  {
    type: Type.Enum({
      command: "command",
      text: "text",
      skill: "skill",
      url: "url",
      none: "none",
    } as const),
    value: Type.String({ maxLength: 4096 }),
    label: Type.String({ maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type MicroBinding = Omit<Static<typeof BindingSchema>, "type"> & {
  type: "command" | "text" | "skill" | "url" | "none";
};
export const PreferencesSchema = Type.Object(
  {
    brightness: Type.Integer({ minimum: 0, maximum: 100 }),
    autoDim: Type.Enum({
      off: "off",
      seconds30: "30-seconds",
      minute1: "1-minute",
      minutes3: "3-minutes",
      minutes10: "10-minutes",
      minutes30: "30-minutes",
      hour1: "1-hour",
    } as const),
    agentSource: Type.Enum({
      recent: "recent",
      pinned: "pinned",
      priority: "priority",
      custom: "custom",
    } as const),
    encoderMode: Type.Enum({ navigation: "composer-navigation", reasoning: "reasoning" } as const),
    microphoneMode: Type.Enum({ hold: "push-to-talk", toggle: "toggle-dictation" } as const),
    separateMicrophoneKeys: Type.Boolean(),
    focusSingleTap: Type.Boolean(),
    customSessionKeys: Type.Array(Type.Union([Type.String({ maxLength: 512 }), Type.Null()]), {
      minItems: 6,
      maxItems: 6,
    }),
    bindings: Type.Record(
      Type.String({
        enum: [
          "ACT06",
          "ACT07",
          "ACT08",
          "ACT09",
          "ACT10",
          "ACT11",
          "ACT12",
          "up",
          "right",
          "down",
          "left",
          "ENC_CLK",
        ],
      }),
      BindingSchema,
      { maxProperties: 12 },
    ),
  },
  { additionalProperties: false },
);
export type MicroPreferences = Omit<Static<typeof PreferencesSchema>, "bindings"> & {
  bindings: Record<string, MicroBinding>;
};
const binding = (value: string, label: string): MicroBinding => ({ type: "command", value, label });
export function defaultMicroPreferences(): MicroPreferences {
  return {
    brightness: 100,
    autoDim: "3-minutes",
    agentSource: "recent",
    encoderMode: "composer-navigation",
    microphoneMode: "push-to-talk",
    separateMicrophoneKeys: false,
    focusSingleTap: false,
    customSessionKeys: Array.from({ length: 6 }, () => null),
    bindings: {
      ACT06: binding("fast", "Fast mode"),
      ACT07: binding("approve", "Approve"),
      ACT08: binding("decline", "Decline"),
      ACT09: binding("fork", "Fork conversation"),
      ACT10: binding("microphone", "Push to talk"),
      ACT11: binding("microphone", "Push to talk"),
      ACT12: binding("send", "Send"),
      up: binding("plan", "Plan mode"),
      right: binding("forward", "Forward"),
      down: binding("sidebar", "Toggle sidebar"),
      left: binding("back", "Back"),
      ENC_CLK: binding("enter", "Select"),
    },
  };
}
export function emptyMicroSlots(): MicroSlot[] {
  return Array.from({ length: 6 }, (_, id) => ({
    id,
    sessionKey: null,
    title: null,
    status: "off",
    selected: false,
  }));
}
const DeviceSchema = Type.Object(
  {
    connected: Type.Boolean(),
    product: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    firmware: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    transport: Type.Union([Type.Enum({ USB: "USB", BLE: "BLE" } as const), Type.Null()]),
    battery: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    charging: Type.Boolean(),
    inputPermission: Type.Enum({
      granted: "granted",
      denied: "denied",
      unknown: "unknown",
      unsupported: "unsupported",
    } as const),
    error: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    inputCount: Type.Integer({ minimum: 0 }),
    dimmed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MicroDevice = Static<typeof DeviceSchema>;
const InputSchema = Type.Object(
  {
    clientId: Type.String({ maxLength: 128 }),
    connectionId: Type.String({ minLength: 1, maxLength: 128 }),
    sequence: Type.Integer({ minimum: 1 }),
    kind: Type.Enum({ key: "key", radial: "radial" } as const),
    key: Type.Optional(Type.String({ maxLength: 64 })),
    act: Type.Optional(Type.Number()),
    angle: Type.Optional(Type.Number()),
    distance: Type.Optional(Type.Number()),
    sessionKey: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MicroInput = Static<typeof InputSchema>;
const ReceiptSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    action: Type.String({ maxLength: 128 }),
    ok: Type.Boolean(),
    message: Type.String({ maxLength: 512 }),
  },
  { additionalProperties: false },
);
export type MicroReceipt = Static<typeof ReceiptSchema>;
const SyncSchema = Type.Object(
  {
    clientId: Type.String({ minLength: 1, maxLength: 128 }),
    focused: Type.Boolean(),
    slots: SlotsSchema,
    voiceState: Type.Enum({
      idle: "idle",
      recording: "recording",
      processing: "processing",
      completed: "completed",
    } as const),
  },
  { additionalProperties: false },
);
export type MicroSync = Omit<Static<typeof SyncSchema>, "slots"> & { slots: MicroSlot[] };
const empty = Type.Object({}, { additionalProperties: false });
const ok = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
export const macropadContract = defineFeatureContract({
  pluginId: MACROPAD_PLUGIN_ID,
  operations: {
    "device.get": {
      kind: "query",
      description: "Read verified Codex Micro connection and permission state.",
      input: empty,
      output: DeviceSchema,
    },
    "slots.list": {
      kind: "query",
      description: "Read the six displayed conversation slots.",
      input: empty,
      output: SlotsSchema,
    },
    "preferences.get": {
      kind: "query",
      description: "Read Codex Micro lighting and control assignments.",
      input: empty,
      output: PreferencesSchema,
    },
    "preferences.set": {
      kind: "action",
      description: "Save Codex Micro lighting and control assignments.",
      input: PreferencesSchema,
      output: PreferencesSchema,
    },
    "ui.sync": {
      kind: "action",
      description:
        "Synchronize this operator's visible conversations and active device-control surface.",
      input: SyncSchema,
      output: ok,
    },
    "ui.release": {
      kind: "action",
      description:
        "Release this operator's device-control surface without replaying pending inputs.",
      input: Type.Object(
        { clientId: Type.String({ maxLength: 128 }) },
        { additionalProperties: false },
      ),
      output: ok,
    },
    "ui.result": {
      kind: "action",
      description: "Record the visible result of a physical control action.",
      input: Type.Object(
        { ...ReceiptSchema.properties, clientId: Type.String({ maxLength: 128 }) },
        { additionalProperties: false },
      ),
      output: ok,
    },
    "device.identify": {
      kind: "action",
      description: "Briefly identify the attached device, then restore current lighting.",
      input: empty,
      output: ok,
    },
  },
  events: {
    device_changed: DeviceSchema,
    slots_changed: SlotsSchema,
    preferences_changed: PreferencesSchema,
    input: InputSchema,
    result: ReceiptSchema,
  },
});

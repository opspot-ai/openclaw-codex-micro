import {
  defineFeaturePlugin,
  type FeatureInvocationContext,
} from "openclaw/plugin-sdk/feature-plugin";
import { Value } from "typebox/value";
import { macropadContract, PreferencesSchema, type MicroPreferences } from "./contract.js";
import { MicroService } from "./src/service.js";

function requireOperatorConnection(context: FeatureInvocationContext): string {
  if (
    context.source !== "session-action" ||
    !context.action.client?.connId ||
    !context.action.client.scopes.some(
      (scope) => scope === "operator.write" || scope === "operator.admin",
    )
  ) {
    throw new Error("Open Codex Micro in a connected OpenClaw Control UI with write access.");
  }
  return context.action.client.connId;
}

export default defineFeaturePlugin({
  contract: macropadContract,
  name: "Codex Micro",
  description: "Use a Codex Micro to follow conversations and operate OpenClaw's native controls.",
  setup(api, events) {
    let service: MicroService | undefined;
    let generation = 0;
    const requireService = () => {
      if (!service) {
        throw new Error("Codex Micro service is starting. Try again after the Gateway is ready.");
      }
      return service;
    };
    api.registerService({
      id: "macropad-device",
      async start(context) {
        const current = ++generation;
        const settings = api.runtime.state.openKeyedStore<MicroPreferences>({
          namespace: "preferences",
          maxEntries: 1,
        });
        const next = new MicroService({
          logger: context.logger,
          emit: (event, payload) => {
            if (current !== generation) {
              return;
            }
            events.emit(event, payload);
          },
          loadPreferences: async () => {
            const saved = await settings.lookup("controls");
            if (saved !== undefined && !Value.Check(PreferencesSchema, saved)) {
              throw new Error(
                "Saved Codex Micro preferences are invalid. Reset the layout from its settings page.",
              );
            }
            return saved;
          },
          savePreferences: async (preferences) => {
            if (current !== generation) {
              throw new Error("Codex Micro service stopped; settings were not saved.");
            }
            await settings.register("controls", preferences, {
              assertCurrent: () => {
                if (current !== generation) {
                  throw new Error("Codex Micro service stopped; settings were not saved.");
                }
              },
            });
          },
        });
        service = next;
        try {
          await next.start();
        } catch (error) {
          if (service === next) {
            service = undefined;
          }
          await next.stop();
          throw error;
        }
        if (current !== generation) {
          await next.stop();
        }
      },
      async stop() {
        generation++;
        const previous = service;
        service = undefined;
        await previous?.stop();
      },
    });
    return {
      "device.get": () => requireService().getDevice(),
      "slots.list": () => requireService().getSlots(),
      "preferences.get": () => requireService().getPreferences(),
      "preferences.set": async (preferences, context) => {
        requireOperatorConnection(context);
        return await requireService().setPreferences(preferences);
      },
      "ui.sync": (input, context) =>
        requireService().syncUi(input, requireOperatorConnection(context)),
      "ui.release": (input, context) =>
        requireService().releaseUi(input.clientId, requireOperatorConnection(context)),
      "ui.result": (input, context) =>
        requireService().recordResult(
          input.clientId,
          { sequence: input.sequence, action: input.action, ok: input.ok, message: input.message },
          requireOperatorConnection(context),
        ),
      "device.identify": (_input, context) => {
        requireOperatorConnection(context);
        return requireService().identify();
      },
    };
  },
});

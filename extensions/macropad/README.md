# Codex Micro for OpenClaw

Codex Micro adds conversation shortcuts, status lighting, physical controls,
a native composer bridge, settings, and local games to OpenClaw. It is a
macOS extension, not a standalone application.

**Codex and OpenClaw can both respond to the Micro, and Codex can steal focus.
Fully quit Codex before switching to OpenClaw. There is no seamless switching
or full Codex feature parity.**

## Host requirement

Apply the companion patch in `patches/openclaw-v2026.10.1.patch` to the public
OpenClaw commit `e178c39e9aae3fa440735217f9aef9574f286677` (v2026.10.1). The
patch supplies Plan-mode handling, native focus/dictation hooks, and plugin host
surfaces used by this extension. It is not supported on an unmodified host or
other revisions. Build the host and native OpenClaw companion from that patched
checkout before installing the package.

## Build and install

Use macOS, Node.js `>=24.16.0 <25` or `>=26.1.0`, and pnpm 12.5.1. In a
patched OpenClaw checkout, run the host install/build steps in the root README,
copy this directory to `extensions/macropad`, then run:

```sh
npm install
npm run build
cd ../..
pnpm openclaw plugins build --root extensions/macropad
cd extensions/macropad
npm pack
cd ../..
pnpm openclaw plugins install --no-enable --force --accept-capabilities npm-pack:/absolute/path/to/openclaw-macropad-0.1.0.tgz
pnpm openclaw plugins enable macropad
```

`--no-enable` leaves enablement to the next command. `--force` confirms that
you reviewed and trust this local tarball;
`--accept-capabilities` acknowledges the plugin's declared Micro surface:
device status, six visible slots, preferences, and device-control UI
actions/events. It does not grant macOS Input Monitoring; that remains a
separate permission.

Open the authenticated Control UI. The plugin has no host configuration
fields. Layout, lighting, and device preferences are stored in OpenClaw's
plugin state and changed from the Micro settings page. The package remains
private and is not a public npm release.

## Controls and games

The six agent keys open their assigned conversations; a quick double press
focuses the native window. The encoder navigates the composer and opens
settings. The joystick handles Plan mode, forward, sidebar, and back. Other
keys provide fast mode, approvals, forks, dictation, and send. Settings support
Recent, Pinned, Priority, and custom slots, plus configurable key bindings.

Select **Games** above the composer to play Snake, Brick Breaker, or Asteroids.
Keyboard controls work without a connected Micro; joystick controls require a
connected device and focused composer. Games stop on focus, conversation, or
device changes.

## Permissions and limits

USB and Bluetooth HID access use macOS IOKit. Grant Input Monitoring to the
executable hosting the OpenClaw Gateway and reconnect the device. Hardware
detection and battery reporting have been observed with that permission
provided; full physical-control acceptance remains pending. The plugin does
not flash firmware or write device files.

## Tests and notices

From the OpenClaw checkout root, run the focused browser, game-input, and
controller tests with the verified test runner command:

```sh
node --import ./scripts/tsx.mjs scripts/test-projects.mts \
  extensions/macropad/browser/games.test.ts \
  extensions/macropad/browser/games-controller.test.ts \
  extensions/macropad/browser/controller.test.ts
```

For a separate `plugins validate` check of an unpacked production tarball, the
OpenClaw CLI validator needs its pinned `esbuild` development tool. In a
disposable extracted copy of the package, run `npm install --no-save
--no-package-lock --ignore-scripts esbuild@0.28.2`, then run
`pnpm openclaw plugins validate --root /path/to/extracted/package` from the
patched OpenClaw checkout. `esbuild` is used for build/validation only and is
not a plugin runtime dependency. `LICENSE` retains OpenClaw's MIT terms;
`THIRD-PARTY-NOTICES.md` covers the SDK code bundled into the browser entry and
runtime dependencies.

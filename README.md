# Codex Micro for OpenClaw

This source snapshot contains the `@openclaw/macropad` extension and the
existing OpenClaw host changes it needs. The required patch targets the public
OpenClaw v2026.10.1 commit `e178c39e9aae3fa440735217f9aef9574f286677`; the
extension is not compatible with an unmodified host.

**Codex and OpenClaw can both respond to the Micro, and Codex can steal focus.
Fully quit Codex before switching to OpenClaw. There is no seamless switching
or full Codex feature parity.**

## Build and install

Prerequisites: macOS, Node.js `>=24.16.0 <25` or `>=26.1.0`, and pnpm 12.5.1.
In a fresh OpenClaw checkout, run:

```sh
git clone https://github.com/openclaw/openclaw.git openclaw
cd openclaw
git checkout e178c39e9aae3fa440735217f9aef9574f286677
git apply /path/to/codex-micro/patches/openclaw-v2026.10.1.patch
pnpm install --frozen-lockfile
pnpm build
cp -R /path/to/codex-micro/extensions/macropad extensions/macropad
cd extensions/macropad
npm install
npm run build
cd ../..
pnpm openclaw plugins build --root extensions/macropad
cd extensions/macropad
npm pack
cd ../..
```

The extension build creates `dist/`; `openclaw plugins build` generates the
host-validated, content-addressed Control UI assets and manifest. Install and
enable the tarball from the OpenClaw checkout:

```sh
pnpm openclaw plugins install --no-enable --force --accept-capabilities npm-pack:/absolute/path/to/openclaw-macropad-0.1.0.tgz
pnpm openclaw plugins enable macropad
```

`--no-enable` leaves enablement to the next command. `--force` confirms that
you reviewed and trust this local tarball;
`--accept-capabilities` acknowledges the plugin's declared Micro surface:
device status, six visible slots, preferences, and device-control UI
actions/events. It does not grant macOS Input Monitoring; that remains a
separate permission.

The package remains private (`0.1.0`), not a public npm release. From the
checkout root, run the focused browser, game-input, and controller tests with
the verified test runner command:

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
not a plugin runtime dependency.

## Hardware and limits

The extension provides Codex Micro status, conversation selection, physical
controls, native composer actions, settings, and local games: Snake, Brick
Breaker, and Asteroids. It is macOS-only and needs the native OpenClaw
companion and Input Monitoring permission for host focus and hardware input.
Hardware detection and battery reporting were observed with Input Monitoring
granted; full physical-control acceptance is still pending.

This preparation did not run the full OpenClaw host build, a full native-app
build, or owner physical-control acceptance. These are distinct from the
focused extension tests and package/install checks. OpenClaw source and the
bundled SDK code retain the MIT terms in `LICENSE`; bundled-code and dependency
attributions are in `THIRD-PARTY-NOTICES.md`.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  external: ["openclaw/plugin-sdk/*"],
  sourcemap: false,
});
const browser = await build({
  absWorkingDir: root,
  entryPoints: { index: "browser/index.ts" },
  outdir: "dist/control-ui/build",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  write: false,
  tsconfig: path.join(root, "tsconfig.json"),
});
const hash = createHash("sha256");
for (const file of browser.outputFiles) {
  const name = path.basename(file.path);
  if (!["index.js", "index.css"].includes(name) || file.contents.length > 4 * 1024 * 1024) {
    throw new Error(
      "Codex Micro must ship a bounded self-contained browser entry and optional stylesheet.",
    );
  }
  hash.update(`${name}\0${file.contents.length}\0`).update(file.contents);
}
const directory = `dist/control-ui/${hash.digest("hex")}`;
await fs.mkdir(path.join(root, directory), { recursive: true, mode: 0o755 });
for (const file of browser.outputFiles) {
  const destination = path.join(root, directory, path.basename(file.path));
  const existing = await fs.readFile(destination).catch(() => undefined);
  if (existing && !existing.equals(Buffer.from(file.contents))) {
    throw new Error("An immutable browser build was modified.");
  }
  if (!existing) {
    await fs.writeFile(destination, file.contents, { mode: 0o644 });
  }
}
const manifestPath = path.join(root, "openclaw.plugin.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.controlUi = {
  entry: `${directory}/index.js`,
  ...(browser.outputFiles.some((file) => file.path.endsWith(".css"))
    ? { styles: [`${directory}/index.css`] }
    : {}),
};
const temporary = `${manifestPath}.building`;
await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
await fs.rename(temporary, manifestPath);
console.log(JSON.stringify({ backend: "dist/index.js", controlUi: manifest.controlUi }));

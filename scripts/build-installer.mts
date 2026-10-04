/**
 * Build the Windows installer:  npm run build:installer
 *
 * Produces `build/installer/Costingly-Setup-<version>.exe` — one file that installs the
 * desktop app for the current user, with no administrator prompt and no
 * questions, adds it to the Start menu, and opens it.
 *
 * `npm run build:installer` compiles and bundles the app first (build:desktop)
 * and then runs this. What gets packaged, and why it is packaged the way it
 * is, is installer-config.mts.
 *
 * The first run downloads the installer-making tools (NSIS) and caches them
 * under the user's profile, so it needs a network connection once.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Arch, build, Platform } from "electron-builder";

import { installerConfig, OUT, writeIcon } from "./installer-config.mjs";

if (process.platform !== "win32") {
  console.error("The installer is a Windows installer and is built on Windows.");
  process.exit(1);
}

await writeIcon();

await build({
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  config: installerConfig(),
  publish: "never",
});

const installers = (await readdir(OUT)).filter((name) => /^Costingly-Setup-.*\.exe$/.test(name));
for (const name of installers) {
  const megabytes = (await stat(join(OUT, name))).size / 1024 / 1024;
  console.log(`\n  ${join(OUT, name)}\n  ${megabytes.toFixed(0)} MB\n`);
}
if (installers.length === 0) {
  console.error("electron-builder finished but no installer was found in build/installer/.");
  process.exit(1);
}

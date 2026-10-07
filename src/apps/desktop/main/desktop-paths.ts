/**
 * Where the desktop app keeps what is its own, as opposed to costingly's.
 *
 * The profile (`Data/`) is costingly's: config, cluster, log. Electron also
 * needs somewhere to write — its cache, its session, and the one setting this
 * app has — and that must NOT be inside the profile, because the app promises
 * never to create one just by being opened. A machine where nothing is set up
 * has to stay looking that way.
 *
 * So the app gets a sibling:
 *
 *   %LOCALAPPDATA%\costingly\Data\       the profile
 *   %LOCALAPPDATA%\costingly\Desktop\    this app
 *
 * One parent, so uninstalling means deleting one folder. When `COSTINGLY_HOME`
 * has moved the profile — development, tests — there is no project-named parent
 * to sit beside, and the app's folder follows the profile with a suffix:
 * `.dev-sandbox` and `.dev-sandbox-desktop`.
 */

import { join } from "node:path";

import type { PlatformConfig } from "../../../platform/platform-config.js";
import { projectParentOf } from "../../../platform/profile.js";

/** Electron's userData directory for a profile. Never inside the profile. */
export function desktopDir(profile: PlatformConfig): string {
  const dir = profile.profileDir();
  const parent = projectParentOf(profile, dir);
  return parent === null ? `${dir}-desktop` : join(parent, "Desktop");
}

/** The file the app remembers itself in (desktop-state.service.ts) — not costingly's config.json. */
export function desktopStatePath(profile: PlatformConfig): string {
  return join(desktopDir(profile), "settings.json");
}

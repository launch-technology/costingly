/**
 * Where the desktop app keeps what is its own, as opposed to costingly's.
 *
 * The profile (`Data/`) is costingly's: config, cluster, log. Electron also
 * needs somewhere to write — its cache, its session, and the one setting this
 * app has — and that must NOT be inside the profile, because the status screen
 * promises never to create one. A machine where nothing is set up has to stay
 * looking that way after the app has been opened.
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

import { platform } from "../../domain/project.js";
import { projectParentOf } from "../../platform/profile.js";

/** Electron's userData directory for this profile. Never inside the profile. */
export function desktopDir(): string {
  const profile = platform.profileDir();
  const parent = projectParentOf(platform, profile);
  return parent === null ? `${profile}-desktop` : join(parent, "Desktop");
}

/** The app's own settings — not costingly's config.json. */
export function desktopSettingsPath(): string {
  return join(desktopDir(), "settings.json");
}

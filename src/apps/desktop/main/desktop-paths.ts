/**
 * The files the desktop app keeps in its own folder.
 *
 * The folder itself — a sibling of the profile, never inside it — is the
 * platform's rule (platform/app-dir.ts), shared with the Claude Desktop
 * extension, which reads the connection file from the same place. What sits
 * in it besides that file is this app's business: Electron's own data, the
 * one setting the app has, and the app's log.
 */

import { join } from "node:path";

import { appDir } from "../../../platform/app-dir.js";
import type { PlatformConfig } from "../../../platform/platform-config.js";

/** The file the app remembers itself in (shared/desktop-state.service.ts) — not costingly's config.json. */
export function desktopStatePath(profile: PlatformConfig): string {
  return join(appDir(profile), "settings.json");
}

/** The app's own log. Beside its settings, not in the profile, for the same reason. */
export function desktopLogPath(profile: PlatformConfig): string {
  return join(appDir(profile), "costingly.log");
}

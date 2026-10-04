/**
 * The desktop app's own settings. One of them, so far.
 *
 * Deliberately not `config.json`: that file is costingly's, holds secrets, and
 * creating it would create a profile. This holds nothing sensitive and lives in
 * the app's folder (see desktop-paths.ts), so writing it leaves the profile
 * exactly as it was.
 *
 * Reading is forgiving. A missing, unreadable or malformed file means the
 * defaults — the worst outcome of losing this file is seeing the tray notice a
 * second time, which is not worth an error dialog.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { desktopSettingsPath } from "./desktop-paths.js";

export interface DesktopSettings {
  /** The "still running in the tray" notice has been shown once. */
  closeNoticeShown: boolean;
}

const DEFAULTS: DesktopSettings = { closeNoticeShown: false };

export async function readDesktopSettings(): Promise<DesktopSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(desktopSettingsPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
    const raw = parsed as Record<string, unknown>;
    return {
      closeNoticeShown:
        typeof raw["closeNoticeShown"] === "boolean" ? raw["closeNoticeShown"] : DEFAULTS.closeNoticeShown,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeDesktopSettings(settings: DesktopSettings): Promise<void> {
  const path = desktopSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

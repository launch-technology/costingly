/**
 * What the desktop app remembers about itself between runs. One thing, so far.
 *
 * NOT THE USER'S SETTINGS. Those — the Plaid keys, starting at sign-in — are
 * settings.service.ts, and live where they belong (the profile's config file,
 * and Windows). This is the app's own housekeeping: things nobody chooses,
 * which it simply needs to remember.
 *
 * Deliberately not `config.json`: that file is costingly's, holds secrets, and
 * creating it would create a profile. This holds nothing sensitive and lives in
 * the app's folder (see ../desktop-paths.ts), so writing it leaves the profile
 * exactly as it was.
 *
 * Reading is forgiving. A missing, unreadable or malformed file means the
 * defaults — the worst outcome of losing this file is seeing the tray notice a
 * second time, which is not worth an error dialog.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DesktopState {
  /** The "still running in the tray" notice has been shown once. */
  closeNoticeShown: boolean;
}

const DEFAULTS: DesktopState = { closeNoticeShown: false };

export class DesktopStateService {
  /** @param path The file it is kept in. Its folder is created on first write. */
  constructor(private readonly path: string) {}

  async read(): Promise<DesktopState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
      const raw = parsed as Record<string, unknown>;
      return {
        closeNoticeShown:
          typeof raw["closeNoticeShown"] === "boolean"
            ? raw["closeNoticeShown"]
            : DEFAULTS.closeNoticeShown,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** Change some of it, keeping the rest. */
  async update(changes: Partial<DesktopState>): Promise<void> {
    const next = { ...(await this.read()), ...changes };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}

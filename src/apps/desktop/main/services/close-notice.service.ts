/**
 * Once, the first time the window is closed: say that closing did not quit.
 *
 * Recorded BEFORE it is shown, so a notice that fails to appear is still
 * counted — "at most once" is the promise, and a person who closes the window
 * every day does not want to be told every day.
 *
 * How the notice is drawn is not this file's business; it is handed a function
 * that draws it.
 */

import type { DesktopSettings } from "./settings.service.js";

export interface NoticeSettings {
  read(): Promise<DesktopSettings>;
  update(changes: Partial<DesktopSettings>): Promise<void>;
}

export class CloseNoticeService {
  constructor(
    private readonly settings: NoticeSettings,
    private readonly show: () => void,
  ) {}

  /** The window was closed and hidden instead. */
  async windowHidden(): Promise<void> {
    if ((await this.settings.read()).closeNoticeShown) return;
    await this.settings.update({ closeNoticeShown: true });
    this.show();
  }
}

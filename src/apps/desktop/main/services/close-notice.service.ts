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

import type { DesktopState } from "./desktop-state.service.js";

export interface NoticeMemory {
  read(): Promise<DesktopState>;
  update(changes: Partial<DesktopState>): Promise<void>;
}

export class CloseNoticeService {
  constructor(
    private readonly memory: NoticeMemory,
    private readonly show: () => void,
  ) {}

  /** The window was closed and hidden instead. */
  async windowHidden(): Promise<void> {
    if ((await this.memory.read()).closeNoticeShown) return;
    await this.memory.update({ closeNoticeShown: true });
    this.show();
  }
}

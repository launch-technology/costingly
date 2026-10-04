/**
 * The tray icon: the app's presence while no window is showing.
 *
 * Clicking it opens the window; the menu offers Open and Quit and nothing
 * else. Quit here is the only way the app ends on purpose — closing the window
 * hides it (see main-window.ts) — so this is where the lifecycle the epic
 * promises actually lives.
 */

import { Menu, Tray, type NativeImage } from "electron";

export interface TrayIconOptions {
  icon: NativeImage;
  onOpen(): void;
  onQuit(): void;
}

export class TrayIcon {
  private readonly tray: Tray;

  constructor(options: TrayIconOptions) {
    this.tray = new Tray(options.icon);
    this.tray.setToolTip("Costingly");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Costingly", click: () => options.onOpen() },
        { type: "separator" },
        { label: "Quit", click: () => options.onQuit() },
      ]),
    );
    this.tray.on("click", () => options.onOpen());
  }

  /**
   * Show a notice from the tray.
   *
   * A tray balloon rather than a `Notification`: on Windows a toast from an
   * app that is not installed needs an application identity registered with a
   * Start-menu shortcut, which a developer build does not have. The balloon is
   * drawn by the same notification centre and needs nothing.
   */
  notify(title: string, content: string): void {
    if (!this.tray.isDestroyed()) this.tray.displayBalloon({ iconType: "info", title, content });
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}

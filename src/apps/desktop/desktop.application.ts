/**
 * costingly as a desktop application.
 *
 * The third interface, beside the CLI and the MCP server, and the first that
 * stays up: `start()` claims the single-instance lock and builds the tray and
 * the window, `run()` waits until Quit is chosen, `stop()` releases. Nothing
 * here calls `app.exit()` — that is main.ts's job once the host has run all
 * three phases, which is what guarantees the database pool is closed before
 * the process goes.
 *
 * WHY QUIT IS INTERCEPTED
 *
 * Electron's own `app.quit()` tears the process down on its own schedule, and
 * it is reachable from places this file does not control — a session logoff,
 * a test harness, a future menu. Every one of those goes through `before-quit`,
 * so that is where it is caught, turned into "run() is finished", and left for
 * the host to unwind in order. One exit path, however the quit was asked for.
 *
 * WHY THERE IS NO SECOND WINDOW
 *
 * `requestSingleInstanceLock()` fails in the second copy, which then finishes
 * `run()` immediately and exits without creating anything. The first copy is
 * told about it and brings its window forward. Two copies competing for one
 * database is the failure mode the uptime line in the status report exists to
 * diagnose; this is what prevents it.
 */

import { app, type BrowserWindow, type Tray } from "electron";

import type { Application } from "../../platform/runtime/application.js";
import { ResourceScope } from "../../platform/runtime/resource-scope.js";
import { closeDb } from "../../domain/data/default-database.js";
import { desktopDir } from "./desktop-paths.js";
import { readDesktopSettings, writeDesktopSettings } from "./desktop-settings.js";
import { createMainWindow, revealWindow } from "./main-window.js";
import { placeholderIcon } from "./placeholder-icon.js";
import { registerStatusHandlers } from "./status.ipc.js";
import { createTray } from "./tray.js";

export class DesktopApplication implements Application {
  readonly name = "costingly desktop";

  private readonly scope = new ResourceScope();
  private window: BrowserWindow | undefined;
  private tray: Tray | undefined;

  private quitting = false;
  private secondCopy = false;
  private resolveQuit: (() => void) | undefined;
  private readonly quitRequested = new Promise<void>((resolve) => {
    this.resolveQuit = resolve;
  });

  async start(): Promise<void> {
    // Before anything else, and before `ready`: Electron decides where its
    // cache and session live from this, and the default is %APPDATA%\costingly
    // — a second place on the machine for the uninstaller to know about.
    app.setPath("userData", desktopDir());

    if (!app.requestSingleInstanceLock()) {
      this.secondCopy = true;
      return;
    }

    app.on("second-instance", () => this.open());
    // Windows are hidden, never closed, so this never fires — but Electron's
    // default handler quits the app, and a future window that IS closed must
    // not take the tray with it.
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.requestQuit();
    });

    await app.whenReady();

    this.scope.onClose("database", closeDb);
    registerStatusHandlers();

    const icon = placeholderIcon();
    this.tray = createTray({
      icon,
      onOpen: () => this.open(),
      onQuit: () => this.requestQuit(),
    });
    this.scope.onClose("tray", async () => this.tray?.destroy());

    this.window = await createMainWindow({
      icon,
      isQuitting: () => this.quitting,
      onHidden: () => void this.showCloseNotice(),
    });
    this.scope.onClose("window", async () => this.window?.destroy());
  }

  /** Stay running until Quit. The second copy has nothing to wait for. */
  async run(): Promise<void> {
    if (this.secondCopy) return;
    await this.quitRequested;
  }

  async stop(): Promise<void> {
    // From here on `close` means close, so destroying the window is not
    // intercepted and turned into a hide.
    this.quitting = true;
    await this.scope.closeAll();
  }

  private open(): void {
    if (this.window !== undefined) revealWindow(this.window);
  }

  private requestQuit(): void {
    this.quitting = true;
    this.resolveQuit?.();
  }

  /**
   * Once, the first time the window is closed: say that closing did not quit.
   *
   * Recorded before it is shown, so a notice that fails to appear is still
   * counted — "at most once" is the promise, and a person who closes the window
   * every day does not want to be told every day.
   *
   * A tray balloon rather than a `Notification`: on Windows a toast from an
   * app that is not installed needs an application identity registered with a
   * Start-menu shortcut, which a developer build does not have. The balloon is
   * drawn by the same notification centre and needs nothing.
   */
  private async showCloseNotice(): Promise<void> {
    const settings = await readDesktopSettings();
    if (settings.closeNoticeShown) return;
    await writeDesktopSettings({ ...settings, closeNoticeShown: true });

    this.tray?.displayBalloon({
      iconType: "info",
      title: "Costingly is still running",
      content: "It lives in the system tray. Click the icon to reopen it, or choose Quit to stop.",
    });
  }
}

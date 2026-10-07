/**
 * The one window.
 *
 * Closing it hides it: the app lives in the tray and keeps running until the
 * user chooses Quit, which is what lets the database — and, later, the MCP
 * server — stay up while no window is showing. The `close` event is the only
 * place that decision is made, and `allowClose()` is how a real quit gets
 * past it.
 *
 * The renderer is sandboxed, isolated and node-free. It reaches the main
 * process only through the bridge, and it may not navigate anywhere or open
 * anything — a page that could would turn a Plaid error message into an
 * attack surface.
 */

import { BrowserWindow, type NativeImage, type WebContents } from "electron";
import { join } from "node:path";

import type { DesktopEvent, DesktopEvents } from "../../bridge/contract.js";

/** How long to wait for show+focus to stop arriving before telling the page. */
const SHOWN_COALESCE_MS = 100;

/** dist/apps/desktop — the compiled main/, bridge/ and renderer/ sit under it. */
const APP_ROOT = join(import.meta.dirname, "..", "..");

export interface MainWindowOptions {
  icon: NativeImage;
  /** The user closed the window and it was hidden instead. */
  onHidden(): void;
}

export class MainWindow {
  private readonly window: BrowserWindow;
  private closeAllowed = false;
  private hidden = false;
  private shownTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: MainWindowOptions) {
    this.window = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      title: "Costingly",
      icon: options.icon,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(APP_ROOT, "bridge", "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.window.removeMenu();

    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());

    // Hide, don't close — unless this is the quit path.
    this.window.on("close", (event) => {
      if (this.closeAllowed) return;
      event.preventDefault();
      this.hidden = true;
      this.window.hide();
      this.options.onHidden();
    });

    this.window.on("show", () => this.announceShown());
    this.window.on("focus", () => this.announceShown());
  }

  /**
   * Load the page and, unless told otherwise, show the window once it has
   * something to show.
   *
   * `show: false` is for a start nobody asked to look at — sign-in. The page
   * is loaded all the same, so the tray's Open reveals a finished window, and
   * the window counts as hidden from the start: revealing it announces
   * `window.shown`, like a return from the tray.
   */
  async open(options: { show: boolean } = { show: true }): Promise<void> {
    const ready = new Promise<void>((resolve) => this.window.once("ready-to-show", resolve));
    await this.window.loadFile(join(APP_ROOT, "renderer", "index.html"));
    await ready;
    if (options.show) this.window.show();
    else this.hidden = true;
  }

  /** Is this page the main window's? Asked of every call that arrives. */
  owns(contents: WebContents): boolean {
    return !this.window.isDestroyed() && this.window.webContents === contents;
  }

  /** Bring a hidden or buried window back. */
  reveal(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  /** From here on, `close` means close. Called once Quit has been chosen. */
  allowClose(): void {
    this.closeAllowed = true;
  }

  destroy(): void {
    if (this.shownTimer !== undefined) clearTimeout(this.shownTimer);
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  /**
   * Tell the page something, by the contract's event names. Hidden or not: a
   * page that is not being looked at still keeps what it shows up to date.
   */
  emit<E extends DesktopEvent>(event: E, ...args: DesktopEvents[E]): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(event, ...args);
  }

  /**
   * Tell the page it is being looked at again — once per return rather than
   * once per event. Coming back from the tray fires show AND focus, and the
   * first paint fires both before the page has anyone listening.
   */
  private announceShown(): void {
    if (!this.hidden && !this.window.isVisible()) return;
    if (this.shownTimer !== undefined) clearTimeout(this.shownTimer);
    this.shownTimer = setTimeout(() => {
      this.shownTimer = undefined;
      this.emit("window.shown");
    }, SHOWN_COALESCE_MS);
  }
}

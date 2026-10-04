/**
 * The one window.
 *
 * Closing it hides it: the app lives in the tray and keeps running until the
 * user chooses Quit, which is what lets the MCP server and the database stay
 * up in later stories while no window is showing. The `close` event is the
 * only place that decision is made, and `isQuitting()` is how a real quit gets
 * past it.
 *
 * The renderer is sandboxed, isolated and node-free. It reaches the main
 * process only through the preload bridge, and it may not navigate anywhere or
 * open anything — a status screen has no reason to, and a page that could
 * would turn a Plaid error message into an attack surface.
 */

import { BrowserWindow, type NativeImage } from "electron";
import { join } from "node:path";

/** How long to wait for show+focus to stop arriving before telling the page. */
const SHOWN_COALESCE_MS = 100;

export interface MainWindowOptions {
  icon: NativeImage;
  /** True once Quit was chosen, so `close` is allowed to mean close. */
  isQuitting(): boolean;
  /** The window was closed by the user and hidden instead. */
  onHidden(): void;
}

export async function createMainWindow(options: MainWindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: "Costingly",
    icon: options.icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  // Hide, don't close — unless this is the quit path.
  let hidden = false;
  window.on("close", (event) => {
    if (options.isQuitting()) return;
    event.preventDefault();
    hidden = true;
    window.hide();
    options.onHidden();
  });

  // Tell the page it is being looked at again, once per return rather than
  // once per event: coming back from the tray fires show AND focus, and the
  // first paint fires both before the page has anyone listening.
  let shownTimer: NodeJS.Timeout | undefined;
  const announceShown = (): void => {
    if (!hidden && !window.isVisible()) return;
    if (shownTimer !== undefined) clearTimeout(shownTimer);
    shownTimer = setTimeout(() => {
      shownTimer = undefined;
      if (!window.isDestroyed()) window.webContents.send("window:shown");
    }, SHOWN_COALESCE_MS);
  };
  window.on("show", announceShown);
  window.on("focus", announceShown);

  const shown = new Promise<void>((resolve) => window.once("ready-to-show", resolve));
  await window.loadFile(join(import.meta.dirname, "renderer", "index.html"));
  await shown;
  window.show();

  return window;
}

/** Bring a hidden or buried window back. */
export function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

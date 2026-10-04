/**
 * The tray icon: the app's presence while no window is showing.
 *
 * Clicking it opens the window; the menu offers Open and Quit and nothing
 * else. Quit here is the only way the app ends on purpose — closing the window
 * hides it (see main-window.ts) — so this is where the lifecycle the epic
 * promises actually lives.
 */

import { Menu, Tray, type NativeImage } from "electron";

export interface TrayOptions {
  icon: NativeImage;
  onOpen(): void;
  onQuit(): void;
}

export function createTray(options: TrayOptions): Tray {
  const tray = new Tray(options.icon);
  tray.setToolTip("Costingly");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Costingly", click: () => options.onOpen() },
      { type: "separator" },
      { label: "Quit", click: () => options.onQuit() },
    ]),
  );
  tray.on("click", () => options.onOpen());
  return tray;
}

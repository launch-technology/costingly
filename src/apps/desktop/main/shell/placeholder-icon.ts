/**
 * The placeholder icon, as something Electron can show.
 *
 * The drawing itself is placeholder-pixels.ts, shared with the installer
 * build. This turns it into the image the window and the tray use — generated
 * at runtime, so the running app needs no icon file of its own.
 */

import { nativeImage, type NativeImage } from "electron";

import { placeholderPixels } from "./placeholder-pixels.js";

const SIZE = 32;

export function placeholderIcon(): NativeImage {
  const rgba = placeholderPixels(SIZE);

  // `createFromBitmap` wants blue first on Windows; the drawing is red first.
  const bgra = Buffer.alloc(rgba.length);
  for (let at = 0; at < rgba.length; at += 4) {
    bgra[at] = rgba[at + 2] ?? 0;
    bgra[at + 1] = rgba[at + 1] ?? 0;
    bgra[at + 2] = rgba[at] ?? 0;
    bgra[at + 3] = rgba[at + 3] ?? 0;
  }

  return nativeImage.createFromBitmap(bgra, { width: SIZE, height: SIZE });
}

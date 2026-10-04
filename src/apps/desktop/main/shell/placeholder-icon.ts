/**
 * An icon drawn in code, until there is a real one.
 *
 * A flat rounded square in one colour, built as a raw bitmap. Generating it
 * here means no binary file in the repository and nothing for the build to
 * copy, which is the right trade while the icon is a placeholder; the branding
 * story replaces this with a designed .ico and deletes the file.
 */

import { nativeImage, type NativeImage } from "electron";

const SIZE = 32;
/** The fill, as B, G, R — the byte order `createFromBitmap` expects on Windows. */
const FILL = [0x7a, 0x5c, 0x1f] as const;

export function placeholderIcon(): NativeImage {
  const radius = SIZE / 4;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!insideRoundedSquare(x + 0.5, y + 0.5, radius)) continue;
      const at = (y * SIZE + x) * 4;
      pixels[at] = FILL[0];
      pixels[at + 1] = FILL[1];
      pixels[at + 2] = FILL[2];
      pixels[at + 3] = 0xff;
    }
  }

  return nativeImage.createFromBitmap(pixels, { width: SIZE, height: SIZE });
}

function insideRoundedSquare(x: number, y: number, radius: number): boolean {
  // Distance from the nearest corner's circle centre; inside the straight
  // edges the clamped distance is zero and the point is trivially in.
  const dx = Math.max(radius - x, 0, x - (SIZE - radius));
  const dy = Math.max(radius - y, 0, y - (SIZE - radius));
  return dx * dx + dy * dy <= radius * radius;
}

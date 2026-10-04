/**
 * The placeholder icon, as pixels.
 *
 * A flat rounded square in one colour. Kept apart from placeholder-icon.ts,
 * and free of any import, because two things draw it: the running app (for the
 * window and the tray) and the installer build (for the .ico Windows shows in
 * the Start menu and the installed-apps list). The build runs in plain node
 * and cannot load Electron, so the drawing lives where both can reach it.
 *
 * The branding story replaces the icon with a designed one and deletes both
 * files.
 */

/** Red, green, blue. */
const FILL = [0x1f, 0x5c, 0x7a] as const;

/**
 * The icon at `size` pixels square, as RGBA bytes, row by row from the top.
 * Pixels outside the rounded square are fully transparent.
 */
export function placeholderPixels(size: number): Uint8Array {
  const radius = size / 4;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!insideRoundedSquare(x + 0.5, y + 0.5, size, radius)) continue;
      const at = (y * size + x) * 4;
      pixels[at] = FILL[0];
      pixels[at + 1] = FILL[1];
      pixels[at + 2] = FILL[2];
      pixels[at + 3] = 0xff;
    }
  }

  return pixels;
}

function insideRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
  // Distance from the nearest corner's circle centre; inside the straight
  // edges the clamped distance is zero and the point is trivially in.
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
}

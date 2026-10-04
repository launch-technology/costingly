/**
 * Bundle the desktop app's window:  npm run build:desktop
 *
 * The main process is ordinary TypeScript and `npm run build` (tsc) compiles
 * it with everything else. The window is browser code — React, Tailwind, an
 * HTML page — and tsc cannot bundle that, so Vite does, here, into
 * `dist/apps/desktop/renderer/` beside the compiled main process.
 *
 * All of Vite's configuration lives in this call rather than in a config file
 * under src/: the renderer folder holds only what runs in the window, and the
 * build is a dev script like the others in this directory.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RENDERER = join(ROOT, "src", "apps", "desktop", "renderer");
const OUT = join(ROOT, "dist", "apps", "desktop", "renderer");

await build({
  root: RENDERER,
  // Relative URLs: the page is loaded from disk with `loadFile`, where an
  // absolute `/assets/...` would resolve to the drive root.
  base: "./",
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
  },
});

console.log(`desktop renderer bundled to ${OUT}`);

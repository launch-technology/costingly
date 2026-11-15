/**
 * The About screen's wiring: the program's description of itself, from
 * package.json, and the data folder. WIRING ONLY, read as they are.
 *
 * The version is costingly's own, the same one the extension compares against
 * and the CLI prints. Electron's `app.getVersion()` is Electron's own version
 * when the app runs from source, and only becomes ours once packaged.
 */

import { platform } from "../../../../../domain/project.js";
import { packageInfo } from "../../../../../platform/package.js";
import type { AboutDependencies } from "./about.controller.js";

export function aboutDependencies(): AboutDependencies {
  return {
    info: packageInfo,
    dataFolder: () => platform.displayPath(platform.profileDir()),
  };
}

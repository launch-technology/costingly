/**
 * Where the extension file is, for the Claude Desktop screen.
 *
 * INSTALLED, the installer puts `costingly-<version>.mcpb` under the app's
 * resources folder, in `extension/` (scripts/installer-config.mts). RUN FROM
 * SOURCE, the bundle command writes the same file to `build/` at the
 * repository root and nothing else does, so a developer who has not built it
 * is told the command. The folder is decided by the composition root, which
 * is the one place that knows whether this is the packaged app; this only
 * looks inside it.
 *
 * The version is read from the file name, which the bundle command writes
 * from package.json and the packaged-app check proves; opening the zip to read
 * the manifest would say the same thing more slowly.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../../../../../platform/package.js";

/** What builds the file when it is not there. */
export const BUILD_COMMAND = "npm run build:bundle";

/** The folder inside the packaged app's resources where the installer places the file. */
export const EXTENSION_RESOURCE_FOLDER = "extension";

const EXTENSION_FILE = /^costingly-(\d+\.\d+\.\d+[^/\\]*)\.mcpb$/;

export type ExtensionFile =
  | { state: "found"; path: string; version: string }
  | { state: "missing"; folder: string; buildCommand: string };

/**
 * The folder to look in: the packaged app's `resources/extension/`, or the
 * repository's `build/` when run from source.
 */
export function extensionFolder(packaged: boolean, resourcesPath: string): string {
  return packaged ? join(resourcesPath, EXTENSION_RESOURCE_FOLDER) : join(packageRoot, "build");
}

/**
 * The extension file in `folder`, preferring the one at `appVersion` if more
 * than one is there (a developer's `build/` may hold several), else the
 * newest by version string. A folder that does not exist is simply empty.
 */
export function locateExtension(folder: string, appVersion: string): ExtensionFile {
  const found = listExtensionFiles(folder);
  const exact = found.find((file) => file.version === appVersion);
  const chosen = exact ?? found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  return chosen === undefined ? { state: "missing", folder, buildCommand: BUILD_COMMAND } : { state: "found", ...chosen };
}

function listExtensionFiles(folder: string): Array<{ path: string; version: string }> {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const files: Array<{ path: string; version: string }> = [];
  for (const name of names) {
    const match = EXTENSION_FILE.exec(name);
    if (match?.[1] !== undefined) files.push({ path: join(folder, name), version: match[1] });
  }
  return files;
}

/**
 * The extension's own version.
 *
 * Baked in when the extension is bundled (scripts/build-bundle.mts defines
 * `__MCPB_VERSION__` from package.json), because the bundled file travels
 * alone and has no package.json beside it. Run from source under tsx, there
 * is no define and the repository's package.json is read instead.
 *
 * It is compared with the app's version on every connection: the two are
 * built from the same number, and a different major version means the two
 * no longer agree about what passes between them.
 */

import { readFileSync } from "node:fs";

declare const __MCPB_VERSION__: string | undefined;

export function mcpbVersion(): string {
  if (typeof __MCPB_VERSION__ === "string" && __MCPB_VERSION__ !== "") return __MCPB_VERSION__;
  try {
    const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The leading number of a version, or undefined when there is none to read. */
export function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * Same major version, or a version that cannot be read. Only a major that is
 * clearly different is refused: an odd label is not a reason to stop working.
 */
export function compatible(appVersion: string | undefined, ownVersion: string): boolean {
  if (appVersion === undefined) return true;
  const app = majorOf(appVersion);
  const own = majorOf(ownVersion);
  return app === undefined || own === undefined || app === own;
}

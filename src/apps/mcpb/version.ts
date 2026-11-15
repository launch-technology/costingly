/**
 * The extension's own version.
 *
 * Baked in when the extension is bundled (scripts/build-bundle.mts defines
 * `__MCPB_VERSION__` from package.json), because the bundled file travels
 * alone and has no package.json beside it. Run from source under tsx, there
 * is no define and the repository's package.json is read instead.
 *
 * It is compared with the app's version on every connection, by the rule in
 * platform/version.ts, which the app applies too.
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

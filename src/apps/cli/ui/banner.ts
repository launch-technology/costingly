/**
 * The environment banner shown above `costingly --help`.
 *
 * Reads the profile and config directly rather than going through validation,
 * because help must still render when the configuration is broken — that is
 * precisely when you are reaching for it. Nothing here throws, and nothing here
 * touches the database.
 */

import { existsSync } from "node:fs";
import { platform } from "../../../domain/project.js";
import { server } from "../../../domain/project.js";

export function environmentBanner(): string {
  const lines: string[] = [];

  const source = platform.profileSource() === "home variable" ? platform.homeVar : "default";
  lines.push(`  Profile             ${platform.displayPath(platform.profileDir())}  (${source})`);
  lines.push(`  Database            ${platform.displayPath(server.clusterDir())}`);
  lines.push(
    existsSync(platform.configPath())
      ? `  Config              ${platform.displayPath(platform.configPath())}`
      : "  Config              (not set up — run `costingly init`)",
  );

  return `\n${lines.join("\n")}\n`;
}

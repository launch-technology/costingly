/**
 * The environment banner shown above `costingly --help`.
 *
 * Reads the profile and config directly rather than going through validation,
 * because help must still render when the configuration is broken — that is
 * precisely when you are reaching for it. Nothing here throws, and nothing here
 * touches the database.
 */

import { existsSync } from "node:fs";
import { configPath, displayPath, profileDir, profileSource } from "../src/profile.js";
import { clusterDir } from "../src/db/server.js";

export function environmentBanner(): string {
  const lines: string[] = [];

  const source = profileSource() === "COSTINGLY_HOME" ? "COSTINGLY_HOME" : "default";
  lines.push(`  Profile             ${displayPath(profileDir())}  (${source})`);
  lines.push(`  Database            ${displayPath(clusterDir())}`);
  lines.push(
    existsSync(configPath())
      ? `  Config              ${displayPath(configPath())}`
      : "  Config              (not set up — run `costingly init`)",
  );

  return `\n${lines.join("\n")}\n`;
}

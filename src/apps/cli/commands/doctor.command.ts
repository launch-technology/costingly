/**
 * `costingly doctor` — where everything is, and whether it is healthy.
 *
 * The one hard rule: **this must never touch the database.** The failure it
 * most often diagnoses is "the server will not start", and a diagnostic that
 * needs a working server to run is useless exactly when you need it. So no
 * queries, no `ensureServerRunning`, nothing that opens a connection — only
 * `pg_ctl status`, which reads a pid file.
 *
 * The profile line carries a "why". With COSTINGLY_HOME settable from a shell,
 * a .env or a CI runner, "which profile is this, and what chose it?" is the
 * first question in every misconfiguration.
 */

import type { Command } from "commander";
import { stat } from "node:fs/promises";
import { describeConfig } from "../../../domain/config.js";
import { server } from "../../../domain/project.js";
import { platform } from "../../../domain/project.js";
import { packageVersion } from "../../../platform/package.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Show where everything lives and whether it's healthy")
    .helpGroup("Looking at your data:")
    .addHelpText(
      "after",
      `
Never connects to the database, so it still works when the server won't start.
Secrets are reported as present or absent, never printed.`,
    )
    .action(async () => {
      await runDoctor();
    });
}

const OK = "✓";
const NO = "✗";

async function describePath(path: string): Promise<{ exists: boolean; mode?: number; size?: number }> {
  try {
    const info = await stat(path);
    return { exists: true, mode: info.mode & 0o777, size: info.size };
  } catch {
    return { exists: false };
  }
}

function line(label: string, value: string, mark = ""): void {
  console.log(`  ${label.padEnd(12)} ${value}${mark ? `   ${mark}` : ""}`);
}

export async function runDoctor(): Promise<void> {
  console.log("");
  line("costingly", packageVersion());
  console.log("");

  // --- profile --------------------------------------------------------------
  const profile = await describePath(platform.profileDir());
  line("Profile", platform.displayPath(platform.profileDir()), profile.exists ? OK : "not created yet");
  console.log(
    `  ${" ".repeat(12)} ${
      platform.profileSource() === "home variable"
        ? "(COSTINGLY_HOME is set)"
        : "(platform default — COSTINGLY_HOME not set)"
    }`,
  );

  // --- config ---------------------------------------------------------------
  const config = await describePath(platform.configPath());
  if (!config.exists) {
    line("config.json", "missing — run `costingly init`", NO);
  } else {
    // Not a style preference: the file holds live credentials, and anything
    // looser than 0600 means another account on this machine can read them.
    const secure = config.mode === 0o600;
    line(
      "config.json",
      `exists, mode ${(config.mode ?? 0).toString(8).padStart(4, "0")}`,
      secure ? OK : "should be 0600",
    );
  }

  // --- cluster --------------------------------------------------------------
  const cluster = await describePath(server.clusterDir());
  const state = await server.status();
  line(
    "cluster",
    cluster.exists ? `pg18/  ${state === "uninitialised" ? "not initialised" : "initialised"}` : "not created yet",
    cluster.exists && state !== "uninitialised" ? OK : "",
  );
  line("server", state);

  // --- listener -------------------------------------------------------------
  // The port is allocated rather than configured, so printing it is the only way
  // a user can point psql or a GUI client at the right database.
  const { host, port } = await server.credentials();
  line("listener", `${host}:${port}`, OK);

  // --- log ------------------------------------------------------------------
  const logFile = await describePath(server.logPath());
  line(
    "log",
    logFile.exists ? `pg18.log  (${Math.round((logFile.size ?? 0) / 1024)} KB)` : "none yet",
  );

  // --- configuration values -------------------------------------------------
  console.log("");
  console.log("  Configuration");
  for (const { key, source, display } of describeConfig()) {
    const mark = source === "missing" ? NO : "";
    console.log(
      `    ${key.padEnd(15)} ${display.padEnd(24)} ${source === "missing" ? "" : `from ${source}`}${
        mark ? `  ${mark}` : ""
      }`,
    );
  }
  console.log("");
}

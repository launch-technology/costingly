#!/usr/bin/env node
/**
 * costingly — the executable.
 *
 * Everything process-wide happens here exactly once: the composition root
 * below, .env loading, the EPIPE guard, argv parsing, and closing the pg pool.
 * The command tree itself lives in program.ts; command modules only declare
 * their flags and do their work, and none of them touches the process.
 *
 * The shebang must be the first bytes of this file: tsc only preserves it at
 * position 0, and it is what makes the built file directly executable.
 */

import { closeDb, setMigrationSource } from "../../data/db/bootstrap.js";
import { setPublicDir } from "../../web/server.js";
import { isMissingSchema, MISSING_SCHEMA_CLI } from "../../data/db/errors.js";
import { CliError } from "./errors.js";
import { publicDir } from "../../core/package.js";
import { loadMigrations } from "../../data/db/migrations.js";
import { buildProgram } from "./program.js";

// The composition root. data/db and web/ each declare a port — "something must
// give me the migrations", "something must tell me where the static page is" —
// and this is the one place both are answered. Doing it at the single entry
// point every command shares lets the driver migrate the database itself on
// first connection, so nobody has to run `costingly migrate`. That matters most
// where there is no terminal to run it in: a bundled install.
setMigrationSource(loadMigrations);
setPublicDir(publicDir);

/**
 * Exit quietly when a downstream pipe closes.
 *
 * `costingly txns | head` closes stdout while we are still writing, which Node
 * surfaces as an unhandled EPIPE and a stack trace. Every well-behaved CLI
 * swallows it.
 */
function ignoreEpipe(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
}

async function main(): Promise<void> {
  ignoreEpipe();

  // A .env in the current directory is an optional convenience for CI and for
  // development — a way to set environment variables, nothing more. It is never
  // written by costingly and never holds application state; real configuration
  // lives in config.json inside the profile. Absent is the normal case, and
  // loadEnvFile throws when the file is missing, so the throw is swallowed.
  try {
    process.loadEnvFile();
  } catch {
    // No .env here. Expected.
  }

  const program = buildProgram();

  // Bare `costingly` prints the catalog and exits 0.
  //
  // Deliberately not a root .action(): commander only reports "unknown command
  // 'foo'" (with a did-you-mean) while the root program has no action handler.
  // Adding one turns a typo into a confusing "too many arguments" error.
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

main()
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    // Postgres `undefined_table`. On a fresh install this is the very first
    // thing a user hits — the cluster exists but has no schema — and the raw
    // `relation "items" does not exist` is a terrible first impression. The MCP
    // server hits the same error and needs a different wording, so the test for
    // it lives in src/db/errors.ts and both surfaces share it.
    if (isMissingSchema(error)) {
      console.error(MISSING_SCHEMA_CLI);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Safe unconditionally: closeDb() returns early when nothing was opened,
    // so commands that never query cost nothing.
    await closeDb();
  });

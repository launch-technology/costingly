#!/usr/bin/env node
/**
 * costingly — the executable.
 *
 * Launches the terminal application and nothing else. What the application does
 * is cli.application.ts; how a process is run is the host's; this file only says
 * which of the two is being started, and how a failure should read to somebody
 * standing at a terminal.
 *
 * The shebang must be the first bytes of this file: tsc only preserves it at
 * position 0, and it is what makes the built file directly executable.
 */

import { ApplicationHost } from "../../platform/runtime/application-host.js";
import { isMissingSchema } from "../../platform/postgres/errors.js";
import { CliApplication } from "./cli.application.js";
import { CliError } from "./errors.js";

/** What to tell someone at a terminal when the schema is not there yet. */
const MISSING_SCHEMA_CLI = [
  "The database has not been set up yet.",
  "",
  "  costingly init      set up credentials and create it",
  "  costingly migrate   just create the tables",
].join("\n");

/**
 * How a failure reads at a terminal.
 *
 * The MCP server hits the same errors and words them for a model instead, which
 * is why RECOGNISING one lives in platform/postgres/errors.ts and only the
 * wording lives here.
 */
function describeFailure(error: unknown): { message: string; exitCode: number } {
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode };
  }

  // Postgres `undefined_table`. On a fresh install this is the very first thing
  // a user hits — the cluster exists but has no schema — and the raw
  // `relation "items" does not exist` is a terrible first impression.
  if (isMissingSchema(error)) {
    return { message: MISSING_SCHEMA_CLI, exitCode: 1 };
  }

  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

await ApplicationHost.launch(new CliApplication(), { reportError: describeFailure });

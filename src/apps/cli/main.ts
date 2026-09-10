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
import { isMissingSchema, isNotSetUp } from "../../platform/postgres/errors.js";
import { CliApplication } from "./cli.application.js";
import { CliError } from "./errors.js";

/** What to tell someone at a terminal when the schema is not there yet. */
const MISSING_SCHEMA_CLI = [
  "The database exists but has no tables yet.",
  "",
  "  costingly migrate   apply the schema",
].join("\n");

const NOT_SET_UP_CLI = [
  "costingly is not set up on this machine yet.",
  "",
  "  costingly init      set up credentials and create the database",
  "  costingly migrate   create the database only",
  "",
  "`costingly status` shows which profile is in use and what is missing.",
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

  // Nothing installed. Distinct from a missing schema: there is no cluster at
  // all, and no command except the two below will make one — reading has not
  // created a database since provisioning became deliberate.
  if (isNotSetUp(error)) {
    return { message: NOT_SET_UP_CLI, exitCode: 1 };
  }

  // Postgres `undefined_table`. The cluster exists but has no schema — a
  // half-provisioned profile, or migrations interrupted partway.
  if (isMissingSchema(error)) {
    return { message: MISSING_SCHEMA_CLI, exitCode: 1 };
  }

  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

await ApplicationHost.launch(new CliApplication(), { reportError: describeFailure });

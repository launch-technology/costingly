/**
 * costingly as a terminal application.
 *
 * One command per run: `start()` composes, `run()` dispatches whatever was
 * typed, `stop()` releases. Nothing here touches `process` — exit codes and
 * EPIPE belong to the host.
 */

import type { Command } from "commander";

import type { Application } from "../../platform/runtime/application.js";
import { ResourceScope } from "../../platform/runtime/resource-scope.js";
import { closeDb } from "../../domain/data/default-database.js";
import { stopLinkServer } from "../../domain/services/banks/link-session.service.js";
import { buildProgram } from "./program.js";

export class CliApplication implements Application {
  readonly name = "costingly";

  private readonly scope = new ResourceScope();
  private program: Command | undefined;

  async start(): Promise<void> {
    // Registered before anything can acquire them, so a failure part-way through
    // a command still releases whatever came up. `link` used to leave its
    // listener behind on the failure path for exactly this reason.
    //
    // Order is acquisition order and the scope unwinds in reverse: the link
    // server goes first because a command may still be writing to the database
    // while a browser round trip is outstanding.
    this.scope.onClose("database", closeDb);
    this.scope.onClose("link server", stopLinkServer);

    this.program = buildProgram();
  }

  async run(): Promise<void> {
    const program = this.program;
    if (program === undefined) throw new Error("run() before start()");

    // Bare `costingly` prints the catalog and exits 0.
    //
    // Deliberately not a root .action(): commander only reports "unknown
    // command 'foo'" (with a did-you-mean) while the root program has no action
    // handler. Adding one turns a typo into a confusing "too many arguments".
    if (process.argv.length <= 2) {
      program.outputHelp();
      return;
    }

    await program.parseAsync(process.argv);
  }

  async stop(): Promise<void> {
    await this.scope.closeAll();
  }
}

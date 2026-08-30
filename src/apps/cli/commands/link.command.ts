/**
 * `costingly link` — connect a bank from a terminal.
 *
 * The server itself lives in src/link/server.ts, shared with the MCP tool. This
 * file supplies the one thing that module cannot resolve for itself — the path
 * to the static page — and then waits, because a CLI process that returns has
 * nothing left to serve the page with.
 */

import type { Command } from "commander";
import { get } from "../../../core/config.js";
import { startLinkServer, stopLinkServer } from "../../../web/server.js";
import { publicDir } from "../../../core/package.js";

export function registerLinkCommand(program: Command): void {
  program
    .command("link")
    .description("Connect a bank — serves a local page in your browser")
    .helpGroup("Setup — run once, in this order:")
    .addHelpText(
      "after",
      `
Opens a page on 127.0.0.1 only. Your bank credentials are entered inside Plaid's
own window and never reach this app.

Link as many banks as you like, then press Ctrl-C and run \`costingly sync\`.`,
    )
    .action(async () => {
      await runLinkServer();
    });
}

/**
 * Start the server and resolve only once it has shut down.
 *
 * Not returning until shutdown is what lets the single `closeDb()` in index.ts
 * stay correct: a long-lived server must not have its pool closed the moment its
 * action "finishes".
 */
export async function runLinkServer(): Promise<void> {
  const { url } = await startLinkServer(publicDir);

  console.log(`\nPlaid Link server running against the ${get("plaidEnv")} environment.`);
  console.log(`Open ${url} to connect a bank.`);
  console.log("Press Ctrl-C when you are done.\n");

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void stopLinkServer().then(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

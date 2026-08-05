/**
 * `costingly link` — local-only Plaid Link server.
 *
 * Serves one static page that opens Plaid Link, plus the two endpoints that
 * page needs. All the actual Plaid work lives in `src/link.ts`; this file is
 * only the HTTP shell, so nothing here has to move to Next.js later.
 *
 * Bound to 127.0.0.1 on purpose. These endpoints are unauthenticated — anyone
 * who can reach them can attach a bank account to your database — so they must
 * not be exposed on the network.
 */

import type { Command } from "commander";
import express from "express";
import type { Request, Response } from "express";

import { config } from "../src/config.js";
import { createLinkToken, exchangePublicToken } from "../src/link.js";
import { describeError } from "../src/plaid.js";
import { publicDir } from "./paths.js";
import { CliError } from "./errors.js";

export function registerLinkCommand(program: Command): void {
  program
    .command("link")
    .description("Connect a bank — serves a local page on :4000")
    .helpGroup("Setup — run once, in this order:")
    .addHelpText(
      "after",
      `
Opens a page on 127.0.0.1 only. Your bank credentials are entered inside Plaid's
own window and never reach this app.

Link as many banks as you like, then press Ctrl-C and run \`costingly sync\`.
Set PORT in .env to use a port other than 4000.`,
    )
    .action(async () => {
      await runLinkServer();
    });
}

/**
 * Start the server and resolve only once it has shut down.
 *
 * Not returning until shutdown is what lets the single `closeDb()` in
 * index.ts stay correct: a long-lived server must not have its pool closed the
 * moment its action "finishes".
 */
export async function runLinkServer(): Promise<void> {
  // Built inside the function rather than at module scope, so importing this
  // module never starts listening.
  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));

  /** Which Plaid environment the page should tell the user it is talking to. */
  app.get("/api/env", (_req: Request, res: Response) => {
    res.json({ env: config.plaidEnv });
  });

  app.post("/api/create_link_token", async (req: Request, res: Response) => {
    try {
      // An access_token may be supplied to re-authenticate an existing Item
      // (Link "update mode"), e.g. after its status went to 'login_required'.
      const body = req.body as { access_token?: unknown } | undefined;
      const accessToken = typeof body?.access_token === "string" ? body.access_token : undefined;

      const linkToken = await createLinkToken(accessToken === undefined ? {} : { accessToken });
      res.json({ link_token: linkToken });
    } catch (error) {
      const message = describeError(error);
      console.error("[link] create_link_token failed:", message);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/exchange_public_token", async (req: Request, res: Response) => {
    try {
      const body = req.body as { public_token?: unknown } | undefined;
      const publicToken = body?.public_token;

      if (typeof publicToken !== "string" || publicToken === "") {
        res.status(400).json({ error: "public_token is required" });
        return;
      }

      const item = await exchangePublicToken(publicToken);
      console.log(
        `[link] linked ${item.institutionName ?? "(unknown institution)"} ` +
          `— item ${item.itemId}, ${item.accountCount} account(s)`,
      );
      console.log("[link] run `costingly sync` to pull transaction history.");

      res.json(item);
    } catch (error) {
      const message = describeError(error);
      console.error("[link] exchange_public_token failed:", message);
      res.status(500).json({ error: message });
    }
  });

  const port = config.port;

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      console.log(`\nPlaid Link server running against the ${config.plaidEnv} environment.`);
      console.log(`Open http://127.0.0.1:${port} to connect a bank.`);
      console.log("Press Ctrl-C when you are done.\n");
    });

    // Without this an in-use port surfaces as an unhandled 'error' event and a
    // stack trace. Now it is an ordinary CLI failure.
    server.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new CliError(
              `Port ${port} is already in use. Set PORT in .env, or stop the other process.`,
            )
          : error,
      );
    });

    const shutdown = (): void => {
      // Keep-alive sockets from the browser would otherwise hold close() open.
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

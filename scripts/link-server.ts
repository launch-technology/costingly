/**
 * Local-only Plaid Link server.  Usage:  npm run link
 *
 * Serves one static page that opens Plaid Link, plus the two endpoints that
 * page needs. All the actual Plaid work lives in `src/link.ts`; this file is
 * only the HTTP shell, so nothing here has to move to Next.js later.
 *
 * Bound to 127.0.0.1 on purpose. These endpoints are unauthenticated — anyone
 * who can reach them can attach a bank account to your database — so they must
 * not be exposed on the network.
 */

import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config } from "../src/config.js";
import { createLinkToken, exchangePublicToken } from "../src/link.js";
import { describeError } from "../src/plaid.js";
import { closePool } from "../src/db.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(projectRoot, "public");

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

    const linkToken = await createLinkToken(
      accessToken === undefined ? {} : { accessToken },
    );
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
    console.log("[link] run `npm run sync` to pull transaction history.");

    res.json(item);
  } catch (error) {
    const message = describeError(error);
    console.error("[link] exchange_public_token failed:", message);
    res.status(500).json({ error: message });
  }
});

const port = config.port;
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`\nPlaid Link server running against the ${config.plaidEnv} environment.`);
  console.log(`Open http://127.0.0.1:${port} to connect a bank.`);
  console.log("Press Ctrl-C when you are done.\n");
});

async function shutdown(): Promise<void> {
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

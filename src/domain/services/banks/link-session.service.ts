/**
 * The link session: a browser round trip that connects or repairs a bank.
 *
 * A SERVICE, not an interface, even though it serves HTML. Both the CLI and the
 * MCP server need this exact page and this exact post-back handler, so filing it
 * under one of them would mean writing it twice — and a rule that forces
 * anything presentational into `apps/` produces exactly that duplication. The
 * distinction that matters is *whose* experience: `commander` and `clack` render
 * one interface's UX and belong to it; this page is the shared middle of a use
 * case both interfaces invoke.
 *
 * What differs between the two callers is only how they WAIT. The CLI blocks
 * until the browser posts back; a tool call cannot, so it returns a URL and
 * reports the outcome on a later call through `takeRecentLinks`.
 *
 * Plaid Link cannot run anywhere but a real browser. It renders in an iframe
 * from Plaid's CDN, needs storage, and for OAuth institutions it navigates the
 * user to their bank's own website and back. None of that survives inside a
 * sandboxed iframe in a desktop app, so linking always means: start a local
 * server, hand the user a URL, and let their browser do the work.
 *
 * The static page's location comes from `platform/package.ts`, which walks up
 * to the nearest package.json — so this needs nothing from either interface and
 * neither has to hand it anything.
 *
 * NOTHING HERE MAY WRITE TO STDOUT
 *
 * Under the CLI stdout was the user's screen. Under MCP it is the protocol
 * channel, and a single stray line corrupts the session. Diagnostics go to
 * stderr, which Claude Desktop captures into its per-server log; anything a
 * *user* needs to know is recorded in `recentLinks` instead, because a link
 * completes in the browser long after the tool call that started the server has
 * returned, and there is no result left to put it in.
 *
 * BOUND TO LOOPBACK, DELIBERATELY
 *
 * These endpoints are unauthenticated: anything that can reach them can attach a
 * bank to this database. 127.0.0.1 only, and the server shuts itself down once
 * it goes idle, so the window is minutes rather than the lifetime of the process.
 */

import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";

import { publicDir } from "../../../platform/package.js";
import { get } from "../../config.js";
import { ports } from "../../../platform/ports.js";
import {
  createLinkToken,
  exchangePublicToken,
  type LinkedItem,
} from "./link.service.js";
import { createRepairLinkToken, markItemRepaired } from "./relink.service.js";
import { describeError } from "../../data/plaid.client.js";

/** Close the server after this long with no requests. */
const IDLE_MS = 10 * 60 * 1000;

export interface RunningLinkServer {
  url: string;
  port: number;
  /** True when this call started it; false when one was already up. */
  started: boolean;
}

interface State {
  server: Server;
  port: number;
  idleTimer: NodeJS.Timeout;
}

let current: State | undefined;

/**
 * Banks connected since the process started, oldest first.
 *
 * The only way anyone finds out a link succeeded. The browser posts the token
 * back minutes after `link_bank` returned its URL, so the next tool call — sync,
 * status, or link_bank again — reports what happened.
 */
const recentLinks: LinkedItem[] = [];

export function takeRecentLinks(): LinkedItem[] {
  return recentLinks.splice(0, recentLinks.length);
}

/** Connections repaired since the process started. Reported the same way. */
export interface RepairedItem {
  itemId: string;
  institutionName: string | null;
}
const recentRepairs: RepairedItem[] = [];

export function takeRecentRepairs(): RepairedItem[] {
  return recentRepairs.splice(0, recentRepairs.length);
}

/** stderr, never stdout. See the header. */
function log(message: string): void {
  console.error(`[link] ${message}`);
}

function buildApp(publicDir: string, touch: () => void): express.Express {
  const app = express();
  app.use(express.json());

  // Every request postpones the idle shutdown, so a user linking four banks in
  // ten minutes never has the page pulled out from under them.
  app.use((_req, _res, next) => {
    touch();
    next();
  });

  app.use(express.static(publicDir));

  app.get("/api/env", (_req: Request, res: Response) => {
    res.json({ env: get("plaidEnv") });
  });

  // Repairing an existing connection, not adding a new one. Takes an item id —
  // never a token. Plaid access tokens are decrypted only inside this process.
  app.post("/api/repair_link_token", async (req: Request, res: Response) => {
    try {
      const body = req.body as { item_id?: unknown } | undefined;
      if (typeof body?.item_id !== "string" || body.item_id === "") {
        res.status(400).json({ error: "item_id is required" });
        return;
      }
      res.json({ link_token: await createRepairLinkToken(body.item_id) });
    } catch (error) {
      const message = describeError(error);
      log(`repair_link_token failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  // Update mode finishes here, NOT at exchange_public_token. Exchanging would
  // create a second Item for the same bank, which is what this flow avoids.
  app.post("/api/repair_complete", async (req: Request, res: Response) => {
    try {
      const body = req.body as { item_id?: unknown } | undefined;
      if (typeof body?.item_id !== "string" || body.item_id === "") {
        res.status(400).json({ error: "item_id is required" });
        return;
      }
      const { institutionName } = await markItemRepaired(body.item_id);
      recentRepairs.push({ itemId: body.item_id, institutionName });
      log(`repaired ${institutionName ?? "(unknown institution)"} — item ${body.item_id}`);
      res.json({ itemId: body.item_id, institutionName });
    } catch (error) {
      const message = describeError(error);
      log(`repair_complete failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/create_link_token", async (_req: Request, res: Response) => {
    try {
      const linkToken = await createLinkToken();
      res.json({ link_token: linkToken });
    } catch (error) {
      const message = describeError(error);
      log(`create_link_token failed: ${message}`);
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
      recentLinks.push(item);
      log(
        `linked ${item.institutionName ?? "(unknown institution)"} — ` +
          `item ${item.itemId}, ${item.accountCount} account(s)`,
      );

      res.json(item);
    } catch (error) {
      const message = describeError(error);
      log(`exchange_public_token failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  return app;
}

/**
 * Listen on `port`, or reject. Split out so the caller can retry on a free port.
 */
function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    // Without this an in-use port surfaces as an unhandled 'error' event and
    // takes the process down.
    server.once("error", reject);
  });
}

/**
 * Start the link server, or return the one already running.
 *
 * Tries the configured port first so the URL is predictable, then falls back to
 * whatever the OS gives out. Port 4000 being busy is a developer's problem, not
 * a reason a user cannot connect their bank — and since the chosen port is
 * returned in the URL, nothing downstream cares which one it was.
 *
 * (If a Plaid `redirect_uri` is ever registered for OAuth institutions, that URI
 * includes the port, and this should pin it rather than fall back.)
 */
export async function startLinkServer(staticDir = publicDir): Promise<RunningLinkServer> {
  if (current !== undefined) {
    bumpIdle();
    return { url: `http://127.0.0.1:${current.port}`, port: current.port, started: false };
  }

  const app = buildApp(staticDir, bumpIdle);
  // Allocated, not configured: the service remembers what worked last time, so a
  // machine where 4000 is permanently taken stops paying for it on every start.
  const preferred = await ports().allocate("link");

  let server: Server;
  try {
    server = await listen(app, preferred);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    log(`port ${preferred} is in use; taking any free port instead`);
    server = await listen(app, 0);
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : preferred;

  current = { server, port, idleTimer: setTimeout(closeIdle, IDLE_MS) };
  // Do not hold the process open just because this timer exists.
  current.idleTimer.unref();

  log(`listening on 127.0.0.1:${port} (${get("plaidEnv")})`);
  return { url: `http://127.0.0.1:${port}`, port, started: true };
}

function bumpIdle(): void {
  if (current === undefined) return;
  clearTimeout(current.idleTimer);
  current.idleTimer = setTimeout(closeIdle, IDLE_MS);
  current.idleTimer.unref();
}

function closeIdle(): void {
  log("idle — shutting down the link server");
  void stopLinkServer();
}

/** Stop the server if one is running. Safe to call when none is. */
export async function stopLinkServer(): Promise<boolean> {
  const state = current;
  if (state === undefined) return false;
  current = undefined;
  clearTimeout(state.idleTimer);

  await new Promise<void>((resolve) => {
    // Keep-alive sockets from the browser would otherwise hold close() open.
    state.server.closeAllConnections();
    state.server.close(() => resolve());
  });
  return true;
}

/** Whether a server is currently listening, and where. */
export function linkServerStatus(): { running: boolean; port?: number } {
  return current === undefined ? { running: false } : { running: true, port: current.port };
}

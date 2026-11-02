/**
 * The app's one local web server.
 *
 * The second way a request reaches the app, beside ipc-router.ts: the window
 * calls over IPC, and programs on this machine call over HTTP. Today it serves
 * one route, the MCP endpoint; the bank-link page joins it in a later story.
 * It knows nothing about either: it is handed routes and serves them.
 *
 * REFUSE BY DEFAULT. A route is reachable only because it was listed, and it
 * says whether it needs the token. Everything else — an unlisted path, a
 * request naming some other host, a token route asked for by a web page, a
 * body too large — is turned away before any route's code runs, and each
 * refusal is reported to the caller with the reason and the path. Never with
 * the token that was presented: that would put a guessed token in the log.
 *
 * THIS MACHINE ONLY. It binds 127.0.0.1, and it also checks the Host header,
 * which is what stops a web page reaching a local server through a name it
 * made point here. A token route additionally refuses any request carrying an
 * Origin header, because MCP clients are programs and pages do not get in.
 *
 * The token is compared in constant time, and a wrong one gets the same
 * answer as none: 401, with nothing about why.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

/** Whether a route needs the token, or is open to any program on this machine. */
export type RouteAccess = "token" | "open";

export interface Route {
  /** The path, exactly: "/mcp". */
  path: string;
  access: RouteAccess;
  handler: RequestHandler;
}

/** A request that was turned away, and why. Never the presented token. */
export interface Refusal {
  reason: string;
  path: string;
}

export interface LocalHttpServerOptions {
  routes: Route[];
  onRefused(refusal: Refusal): void;
  /** How large a request body may be. */
  maxBodyBytes?: number;
}

export const LOCAL_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class LocalHttpServer {
  private server: Server | undefined;

  constructor(private readonly options: LocalHttpServerOptions) {}

  /**
   * Listen on `port`, with `token` as the key to the token routes. Rejects if
   * the port cannot be bound, which the caller treats as "try the next one".
   */
  async start(port: number, token: string): Promise<void> {
    if (this.server !== undefined) throw new Error("the local server is already running");
    this.server = await listen(this.build(port, token), port);
  }

  /** Stop listening and drop every open connection. Safe to call when not running. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Idle keep-alive connections would otherwise hold `close` open.
      server.closeAllConnections();
    });
  }

  private build(port: number, token: string): express.Express {
    const app = express();
    app.disable("x-powered-by");
    const refuse = (req: Request, res: Response, status: number, reason: string): void => {
      this.options.onRefused({ reason, path: req.path });
      if (status === 401) res.set("WWW-Authenticate", "Bearer");
      res.status(status).type("text").send(reason);
    };

    // The host check comes before anything else, open routes included.
    const hosts = new Set([`${LOCAL_HOST}:${port}`, `localhost:${port}`]);
    app.use((req, res, next) => {
      if (!hosts.has(req.headers.host ?? "")) {
        refuse(req, res, 403, "the request did not name this machine as its host");
        return;
      }
      next();
    });

    const body = express.json({ limit: this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES });
    for (const route of this.options.routes) {
      const access = (req: Request, res: Response, next: NextFunction): void => {
        if (route.access === "open") {
          next();
          return;
        }
        if (req.headers.origin !== undefined) {
          refuse(req, res, 403, "the request came from a web page");
          return;
        }
        const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
        if (presented === undefined || !sameToken(presented, token)) {
          refuse(req, res, 401, presented === undefined ? "no token was presented" : "the token was wrong");
          return;
        }
        next();
      };
      app.all(route.path, access, body, route.handler);
    }

    // Nothing below the listed routes.
    app.use((req, res) => refuse(req, res, 404, "there is nothing at that path"));

    // The body parser's refusals arrive here, and so would a route that threw.
    app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const kind = (error as { type?: string }).type;
      if (kind === "entity.too.large") refuse(req, res, 413, "the request body was too large");
      else if (kind === "entity.parse.failed") refuse(req, res, 400, "the request body was not JSON");
      else refuse(req, res, 500, `the request could not be handled: ${error instanceof Error ? error.message : String(error)}`);
    });

    return app;
  }
}

/** Equal, without the comparison's timing saying how close a wrong token came. */
function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Listen, resolving only once the port is really held.
 *
 * Not `app.listen(port, host, callback)`: Express 5 calls that callback on a
 * bind error as well as on success, so a port already in use would look like
 * a server that started. The 'listening' event fires only for the real thing,
 * and 'error' is caught so an in-use port is a rejection rather than an
 * unhandled event that takes the process down.
 */
function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.listen(port, LOCAL_HOST);
  });
}

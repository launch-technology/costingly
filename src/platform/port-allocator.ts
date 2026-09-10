/**
 * Finding a usable local port, and remembering which one worked.
 *
 * Infrastructure, not domain: this module knows nothing about the project, the
 * database or Plaid. It is handed somewhere to persist its answers and a set of
 * defaults, and it answers one question — "give me a port I can bind for this
 * service". That is what makes it liftable into another MCP server unchanged.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never asks whether a service is currently running, and it never reports
 * which port something is using right now. Only the caller knows what "already
 * running" means — `pg_ctl status` for a database, an open server handle for an
 * HTTP listener — and a caller that finds its service already up must use that
 * port and not call this at all. Asking here would risk allocating a second port
 * for a service that is happily serving on the first.
 */

import { createServer } from "node:net";

export interface PortStore {
  /** Last-known-good port per service name. Missing keys are fine. */
  read(): Promise<Record<string, number>>;
  write(ports: Record<string, number>): Promise<void>;
}

export interface PortServiceOptions {
  store: PortStore;
  /** Where to start looking when nothing has been recorded yet. */
  defaults: Record<string, number>;
  /** How many consecutive ports to try before giving up. */
  maxAttempts?: number;
  /** The address the caller will bind. Probing a different one proves nothing. */
  host?: string;
}

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Is this port bindable right now?
 *
 * By binding it, never by parsing somebody's error text. Every service reports a
 * taken port differently — express raises a clean EADDRINUSE, `pg_ctl` exits
 * non-zero with the reason buried in the postmaster log — and a check that works
 * for one does not work for the next.
 *
 * Advisory only. Another process can take the port between this call and the
 * real bind, so callers keep their own start-failure path as the backstop.
 */
async function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export class PortService {
  private readonly store: PortStore;
  private readonly defaults: Record<string, number>;
  private readonly maxAttempts: number;
  private readonly host: string;

  constructor(options: PortServiceOptions) {
    this.store = options.store;
    this.defaults = options.defaults;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.host = options.host ?? DEFAULT_HOST;
  }

  /**
   * The port last recorded for this service, if any.
   *
   * Deliberately does not probe or allocate. A caller whose service is already
   * running needs the port it is running on, and asking for a free one would
   * step over it and start a second copy.
   */
  async recorded(service: string): Promise<number | undefined> {
    return (await this.store.read())[service];
  }

  /**
   * A port this service can bind, recorded for next time.
   *
   * Starts from whatever worked last, falling back to the default, and walks
   * upward one at a time. Sequential rather than random on purpose: a user who
   * sees 54320 today and 54321 tomorrow can reason about the change and write a
   * firewall rule. A random port every restart is unexplainable.
   */
  async allocate(service: string): Promise<number> {
    const recorded = await this.store.read();
    const start = recorded[service] ?? this.defaults[service];

    if (start === undefined) {
      throw new Error(
        `No default port is configured for "${service}". ` +
          `Known services: ${Object.keys(this.defaults).join(", ") || "(none)"}.`,
      );
    }

    for (let offset = 0; offset < this.maxAttempts; offset += 1) {
      const candidate = start + offset;

      // Ports are 16-bit. Walking off the end is a configuration mistake worth
      // saying out loud rather than wrapping around into the reserved range.
      if (candidate > 65535) break;

      if (await isFree(candidate, this.host)) {
        // Only write when it actually changed. A no-op rewrite of the config
        // file on every start is a lot of disk churn for no information.
        if (recorded[service] !== candidate) {
          await this.store.write({ ...recorded, [service]: candidate });
        }
        return candidate;
      }
    }

    throw new Error(
      `Could not find a free port for "${service}" on ${this.host}. ` +
        `Tried ${start} through ${Math.min(start + this.maxAttempts - 1, 65535)}.`,
    );
  }
}

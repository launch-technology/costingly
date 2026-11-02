/**
 * What a local MCP client needs to reach the app, remembered between runs: the
 * port the endpoint last listened on, and the token every connection must
 * present.
 *
 * In the app's own folder (see ../desktop-paths.ts), not in costingly's
 * config.json: the endpoint is up before setup has run, and opening the app
 * must create nothing of costingly's. The relay extension (a later story)
 * reads this same file to find the endpoint.
 *
 * Reading is forgiving. A missing, unreadable or malformed file means nothing
 * is remembered: the endpoint then takes the next free port from its default
 * and makes a new token, which is the right outcome for a file that is gone.
 *
 * THE TOKEN IS KEPT IN MEMORY once read or written in this process, so the
 * redactor can ask for it on every line it checks without touching the disk.
 *
 * Also the port allocator's memory for the endpoint — `portStore()` is this
 * file wearing the shape the allocator asks for.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PortStore } from "../../../../platform/port-allocator.js";

export interface Connection {
  port?: number;
  token?: string;
}

export class ConnectionFile {
  private known: Connection | undefined;

  /** @param path The file. Its folder is created on first write. */
  constructor(private readonly path: string) {}

  async load(): Promise<Connection> {
    let connection: Connection = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const raw = parsed as Record<string, unknown>;
        const port = raw["port"];
        const token = raw["token"];
        connection = {
          ...(typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
          ...(typeof token === "string" && token !== "" ? { token } : {}),
        };
      }
    } catch {
      // Nothing remembered. See the header.
    }
    this.known = connection;
    return { ...connection };
  }

  /** Change some of it, keeping the rest: recording a port never drops the token. */
  async save(changes: Partial<Connection>): Promise<void> {
    const next = { ...(await this.load()), ...changes };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.known = next;
  }

  /** The token as last read or written in this process. Undefined before either. */
  knownToken(): string | undefined {
    return this.known?.token;
  }

  /** This file as the port allocator's memory for one service. */
  portStore(service: string): PortStore {
    return {
      read: async () => {
        const { port } = await this.load();
        return port === undefined ? {} : { [service]: port };
      },
      write: async (ports) => {
        const port = ports[service];
        if (port !== undefined) await this.save({ port });
      },
    };
  }
}

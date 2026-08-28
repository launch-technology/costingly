/**
 * Costingly's binding for the port allocator.
 *
 * `infra/ports.ts` is deliberately ignorant of where anything is stored. This is
 * the ten lines that point it at `config.json` and name the services costingly
 * actually runs. Keeping them apart is what lets the allocator move to another
 * project without dragging the config format along.
 */

import { readPorts, writePorts } from "./config.js";
import { PortService, type PortStore } from "./infra/ports.js";

/**
 * Where each service starts looking.
 *
 * Not 5432 for the database: a developer machine very likely already runs
 * Postgres there, so the default would collide on first run every time and the
 * allocator would immediately step off it. Starting somewhere quiet means the
 * common case needs no allocation at all.
 */
export const DEFAULT_PORTS: Record<string, number> = {
  database: 54320,
  link: 4000,
};

const store: PortStore = {
  read: async () => readPorts(),
  write: async (ports) => {
    writePorts(ports);
  },
};

/** A fresh instance each call — the service holds no state of its own. */
export function ports(): PortService {
  return new PortService({ store, defaults: DEFAULT_PORTS });
}

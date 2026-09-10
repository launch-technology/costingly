/**
 * Binding the port allocator to a project's config file.
 *
 * `port-allocator.ts` is deliberately ignorant of where anything is stored.
 * This is the few lines that point it at `config.json` and hand it the services
 * a project actually runs. Keeping them apart is what lets the allocator move
 * to another project without dragging the config format along.
 *
 * Which services exist, and where each starts looking, comes from the project's
 * identity — not from a constant here. A platform that named a project's
 * services would not be a platform.
 */

import type { ConfigStore } from "./config-store.js";
import type { PlatformConfig } from "./platform-config.js";
import { PortService, type PortStore } from "./port-allocator.js";

/**
 * A factory, because the service holds no state of its own.
 *
 * Returns a function rather than an instance so callers keep today's
 * `ports().allocate(...)` shape, and so each call reads the file fresh — the
 * profile can move between calls.
 */
export function createPorts(
  config: PlatformConfig,
  store: ConfigStore,
): () => PortService {
  const portStore: PortStore = {
    read: async () => store.readPorts(),
    write: async (ports) => {
      store.writePorts(ports);
    },
  };

  return () => new PortService({ store: portStore, defaults: config.identity.ports });
}

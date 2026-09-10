/**
 * Costingly, as the platform sees it.
 *
 * The one file that says which project this is. Everything under `platform/` is
 * written not to know — it takes an identity and resolves paths, a database
 * name and an environment variable from it — so this is where the answer lives
 * and the only place the word "costingly" appears below the app layer.
 *
 * It is also the composition root for the platform's own chain. Each piece is
 * handed the one below rather than reaching for a global, which is what lets a
 * caller build a second, independent set over a different profile:
 *
 *     identity → PlatformConfig → ConfigStore → ports → PostgresServer
 *
 * `default-database.ts` continues that chain into the pool and the schema.
 */

import { createConfigStore, type ConfigStore } from "../platform/config-store.js";
import {
  resolvePlatform,
  type PlatformConfig,
  type ProjectIdentity,
} from "../platform/platform-config.js";
import { createPorts } from "../platform/ports.js";
import { createDatastore } from "../platform/datastore/postgres-datastore.js";
import type { Datastore } from "../platform/datastore/datastore.js";

/**
 * Who we are.
 *
 * `name` is load-bearing in three places at once: the profile directory, the
 * Postgres database, and the `COSTINGLY_HOME` override. Renaming it moves a
 * user's data, so it is not something to change casually.
 *
 * The ports are where each service starts LOOKING, not where it ends up. 54320
 * rather than 5432 because a developer machine very likely already runs
 * Postgres there, so the default would collide on first run every time and the
 * allocator would immediately step off it. Starting somewhere quiet means the
 * common case needs no allocation at all.
 */
export const costingly: ProjectIdentity = {
  name: "costingly",
  ports: {
    database: 54320,
    link: 4000,
  },
};

/** Paths, the database name, and the `COSTINGLY_HOME` variable. */
export const platform: PlatformConfig = resolvePlatform(costingly);

/** `config.json` inside this profile. */
export const configStore: ConfigStore = createConfigStore(platform);

/** The port allocator, pointed at this profile's config. */
export const ports = createPorts(platform, configStore);

/** This profile's Postgres cluster. */
/**
 * This profile's datastore.
 *
 * Still exported as `server` for now; the callers have not been renamed.
 */
export const server: Datastore = createDatastore(platform, configStore, ports);

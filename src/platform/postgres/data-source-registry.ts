/**
 * Which DataSources exist, by name.
 *
 * Deliberately passive: it stores what it is handed and gives it back. It knows
 * nothing about credentials, `pg`, provisioning or shutdown — those belong to
 * the factory, the bootstrapper and `Database` respectively. Everything it
 * imports is a type.
 *
 * Its value is `all()`: one place that can answer "what has this process
 * opened?", which is what makes an orderly shutdown possible.
 */

import type { DataSource } from "./types/data-source.js";

export class DataSourceRegistry {
  private readonly sources = new Map<string, DataSource>();

  register(name: string, source: DataSource): DataSource {
    this.sources.set(name, source);
    return source;
  }

  /** The source registered under `name`, or undefined if there is none. */
  find(name: string): DataSource | undefined {
    return this.sources.get(name);
  }

  /**
   * The source registered under `name`.
   *
   * Throws rather than returning undefined: a missing name means the
   * composition root failed to register something, which is a wiring bug and
   * should not be discovered three layers away as a null dereference.
   */
  get(name: string): DataSource {
    const source = this.sources.get(name);
    if (source === undefined) {
      throw new Error(`No DataSource is registered as "${name}".`);
    }
    return source;
  }

  all(): DataSource[] {
    return [...this.sources.values()];
  }
}

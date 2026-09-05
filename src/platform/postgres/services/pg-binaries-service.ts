/**
 * The vendored PostgreSQL executables: where they are, and how to run one.
 *
 * PostgreSQL ships here as an ordinary npm dependency rather than something the
 * user installs, which leaves two questions nobody else should have to answer:
 * which package holds the build for this machine, and what a Postgres binary
 * needs in its environment to behave predictably.
 *
 * Owning both is why this is one service. `locate()` answers the first;
 * `run()` answers the second by pinning the locale before handing the work to
 * the OS service. Every other pg-*-service depends on this one and on nothing
 * lower — none of them knows that `initdb` lives inside an optional dependency.
 */

import { OsService, type CommandResult } from "../../services/os-service.js";

/**
 * Postgres major version these binaries provide.
 *
 * A property of what is vendored, which is why it lives with them. A data
 * directory belongs to exactly one major version, so this is also what names
 * the cluster directory — a future upgrade creates a new cluster beside the old
 * one rather than failing with an error about `PG_VERSION`.
 */
export const PG_MAJOR = 18;

/** Absolute paths to the three executables anything here needs. */
export interface PostgresBinaries {
  initdb: string;
  pg_ctl: string;
  postgres: string;
}

/**
 * Which `@embedded-postgres/*` package holds the binaries for this machine.
 *
 * These are `optionalDependencies` declaring `os`/`cpu`, so npm installs only
 * the matching one — the others are absent by design, which is why the import
 * specifier is a variable rather than eight literal imports.
 */
const BINARY_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-arm": "@embedded-postgres/linux-arm",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "linux-ia32": "@embedded-postgres/linux-ia32",
  "linux-ppc64": "@embedded-postgres/linux-ppc64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

/** Module-level, not per-instance: the binaries are the same for every cluster. */
let cachedBinaries: Promise<PostgresBinaries> | undefined;

export class PgBinariesService {
  constructor(private readonly os: OsService) {}

  /**
   * Find the executables for this platform. Cached after the first success.
   *
   * A failure is deliberately NOT cached — a reinstall should be picked up
   * without restarting the process.
   */
  async locate(): Promise<PostgresBinaries> {
    if (cachedBinaries) return cachedBinaries;

    cachedBinaries = (async () => {
      const key = `${process.platform}-${process.arch}`;
      const specifier = BINARY_PACKAGES[key];

      if (specifier === undefined) {
        throw new Error(
          `No PostgreSQL build is available for ${key}.\n\n` +
            `Supported: ${Object.keys(BINARY_PACKAGES).join(", ")}.`,
        );
      }

      try {
        return (await import(specifier)) as PostgresBinaries;
      } catch (error) {
        throw new Error(
          `Could not load the PostgreSQL binaries (${specifier}).\n\n` +
            `This usually means the package was installed with install scripts disabled, or the\n` +
            `download was interrupted. Reinstalling normally fixes it:\n` +
            `  npm install ${specifier}\n\n` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })().catch((error: unknown) => {
      cachedBinaries = undefined;
      throw error;
    });

    return cachedBinaries;
  }

  /**
   * Run one of them.
   *
   * The locale is pinned because `initdb` and `pg_ctl` read `LC_*` and will
   * either fail or produce unparseable output under an exotic one. That is the
   * single Postgres-specific thing about running these, which is why it lives
   * here and not in the OS service.
   */
  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    return this.os.run(file, args, {
      env: { LC_ALL: "C", LANG: "C" },
      label: "postgres",
    });
  }
}

/**
 * The report a person copies to explain a problem: how the app stands right
 * now, and what it and its database have been doing lately.
 *
 * Gathered, not computed. The facts are the ones the Status screen already
 * checks — profile, database, Plaid — plus the bank listing and the tail of
 * each log. What this adds is independence: EACH PART IS GATHERED ON ITS OWN,
 * and one that cannot be read becomes a line saying so while the rest is kept.
 * A report that fails because the database is down would be useless exactly
 * when it is wanted.
 *
 * Two decisions echo the Database section (features/database/database.controller.ts):
 * when the start is known to have failed and the server is down, the health
 * check is not run — it would wait on a port that may belong to another
 * program — and the remembered failure is reported instead; and the banks are
 * read only once the health check has connected, so a stopped database is
 * never asked for them.
 *
 * Wording is report.presenter.ts, beside this. No Electron here, and no domain
 * imports beyond types.
 */

import type { ItemAccountListing } from "../../../../../domain/data/repositories/items.repository.js";
import type { DatabaseHealth } from "../../../../../domain/services/database/database-health.service.js";
import type { PlaidStatus, ProfileStatus } from "../../../../../domain/services/status.service.js";
import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import type { LogExcerpt } from "../../../bridge/contract.js";
import type { DatabaseFailure } from "../database/database.service.js";

/** How many lines of each log the report carries. Enough to see what led up to a failure; short enough to paste. */
export const REPORT_LOG_LINES = 300;

export interface ReportDependencies {
  version(): string;
  profile(): Promise<ProfileStatus>;
  plaid(): Promise<PlaidStatus>;
  database: {
    /** The full health check: server state, a login, and the schema. */
    health(): Promise<DatabaseHealth>;
    /** Only whether the server is up. Reads a pid file; never touches the port. */
    state(): Promise<DatastoreState>;
  };
  /** What the database service remembers going wrong, if anything. */
  lastFailure(): DatabaseFailure | undefined;
  /** Every bank with every account beneath it, one row per account. */
  banks(): Promise<ItemAccountListing[]>;
  appLog: { excerpt(maxLines: number): Promise<LogExcerpt> };
  databaseLog: { excerpt(maxLines: number): Promise<LogExcerpt> };
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
  now(): Date;
}

/** One part of the report: what was found, or why it could not be. */
export type Part<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The database as the report can see it: checked, or known to have failed to start. */
export type DatabaseReport = { checked: true; health: DatabaseHealth } | { checked: false; failure: DatabaseFailure };

export interface Report {
  version: string;
  generatedAt: Date;
  profile: Part<ProfileStatus>;
  database: Part<DatabaseReport>;
  plaid: Part<PlaidStatus>;
  banks: Part<ItemAccountListing[]>;
  appLog: LogExcerpt;
  databaseLog: LogExcerpt;
}

export class ReportService {
  constructor(private readonly deps: ReportDependencies) {}

  /** Gather everything. Never throws: a part that fails is reported as such. */
  async assemble(): Promise<Report> {
    const [profile, database, plaid, appLog, databaseLog] = await Promise.all([
      this.part(() => this.deps.profile()),
      this.part(() => this.database()),
      this.part(() => this.deps.plaid()),
      this.deps.appLog.excerpt(REPORT_LOG_LINES),
      this.deps.databaseLog.excerpt(REPORT_LOG_LINES),
    ]);

    return {
      version: this.deps.version(),
      generatedAt: this.deps.now(),
      profile,
      database,
      plaid,
      banks: await this.banks(database),
      appLog,
      databaseLog,
    };
  }

  private async database(): Promise<DatabaseReport> {
    const failure = this.deps.lastFailure();
    if (
      (failure?.kind === "will-not-start" || failure?.kind === "port-in-use") &&
      (await this.deps.database.state()) === "stopped"
    ) {
      return { checked: false, failure };
    }
    return { checked: true, health: await this.deps.database.health() };
  }

  /** Only a database that answered the health check is asked for its banks. */
  private async banks(database: Part<DatabaseReport>): Promise<Part<ItemAccountListing[]>> {
    if (!database.ok) return { ok: false, reason: "the database could not be checked" };
    if (!database.value.checked) return { ok: false, reason: "the database is not running" };
    if (!database.value.health.connection.ok) return { ok: false, reason: "the database did not answer" };
    return this.part(() => this.deps.banks());
  }

  private async part<T>(read: () => Promise<T>): Promise<Part<T>> {
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      return { ok: false, reason: this.deps.describeError(error) };
    }
  }
}

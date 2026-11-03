/**
 * sync — pull the latest transactions from the user's banks.
 *
 * THE SAME SYNC THE BUTTON STARTS. The app runs one sync at a time whoever
 * asks, and the Accounts screen shows this run as it shows the button's. The
 * tool starts it (or finds one already running and starts nothing), waits a
 * little for a quick one to finish, and reports. It never waits out a long
 * one: a first sync of a newly linked bank can take minutes, and a client
 * would give up long before. Past the wait it says the sync is running and
 * that sync_status reports the result.
 *
 * The wait is short on purpose, under the shortest limit common clients put
 * on a tool call; the composition root sets the number.
 */

import type { DatastoreState } from "../../../../../platform/datastore/datastore.js";
import type { SyncService } from "../../features/sync/sync.service.js";
import { databaseUnavailable } from "../presenters/query-result.presenter.js";
import {
  UNLINK_IN_PROGRESS,
  alreadyRunning,
  formatSyncSummary,
  runFailed,
  stillRunning,
} from "../presenters/sync-report.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface SyncToolDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  sync: Pick<SyncService, "start" | "state" | "whenSettled">;
  now(): Date;
  /** How long to wait for the run to finish before answering "still running". */
  waitMs: number;
}

export class SyncTool implements Tool {
  readonly name = "sync";

  constructor(private readonly deps: SyncToolDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Sync Transactions From Banks",
        description:
          "Pull the latest transactions and balances from the user's banks via Plaid " +
          "and store them locally. Everything else here reads a local snapshot; this " +
          "is the only tool that refreshes it.\n\n" +
          "Call it when the user asks to refresh, when they mention a purchase too " +
          "recent to be in the data, or at the start of a report so the figures are " +
          "current. Do not call it before every query — the data does not change " +
          "between questions.\n\n" +
          "It starts the sync and waits a few seconds. An ordinary sync finishes in " +
          "that time and you get the result. A long one — the first sync of a newly " +
          "linked bank backfills up to two years — does not, and you are told it is " +
          "still running: call sync_status for the result, and do not call sync again " +
          "meanwhile. If a sync is already running, from this endpoint or from the " +
          "app, nothing new is started and you are told so.\n\n" +
          "Safe to re-run: changes are keyed on transaction id, so a second run in a " +
          "row adds nothing.\n\n" +
          "Banks sync independently and some can fail while others succeed — most " +
          "often because a bank's login expired and relink_bank is needed. When that " +
          "happens the result says so at the top, and any figures you report " +
          "afterwards are incomplete. Pass that on to the user rather than presenting " +
          "partial data as a full picture.",
        // Every hint stated. The defaults are readOnlyHint false,
        // destructiveHint TRUE, idempotentHint false, openWorldHint TRUE —
        // so silence here would advertise a destructive, non-idempotent
        // tool and invite clients to gate it far harder than it deserves.
        annotations: {
          // Writes: upserts transactions, removes ones Plaid reports gone,
          // refreshes balances, advances each item's cursor.
          readOnlyHint: false,
          // Deletions are reconciliation with the source of truth, never of
          // anything the user created, and a later sync restores anything
          // removed in error.
          destructiveHint: false,
          // Cursor-based. Running twice in a row adds nothing — the property
          // that makes an unattended schedule safe.
          idempotentHint: true,
          // The only tool here that leaves the machine. Network latency,
          // third-party outages and the user's Plaid quota all apply.
          openWorldHint: true,
        },
      },
      async () => {
        const database = await this.deps.state();
        if (database !== "running") {
          return { content: [{ type: "text", text: databaseUnavailable(database) }], isError: true };
        }

        const before = this.deps.sync.state();
        if (before.phase === "running") {
          return { content: [{ type: "text", text: alreadyRunning(before.startedAt, this.deps.now()) }] };
        }

        const started = this.deps.sync.start("mcp");
        if (started.phase !== "running") {
          // The only reason a start is refused when nothing is running: a
          // bank is being unlinked, and the two never overlap.
          return { content: [{ type: "text", text: UNLINK_IN_PROGRESS }], isError: true };
        }

        const ended = await Promise.race([this.deps.sync.whenSettled(), after(this.deps.waitMs)]);
        if (ended === undefined || ended.phase === "running") {
          return { content: [{ type: "text", text: stillRunning(started.startedAt, this.deps.now()) }] };
        }
        if (ended.phase === "failed") {
          return { content: [{ type: "text", text: runFailed(ended.reason) }], isError: true };
        }
        if (ended.phase === "finished") {
          const { summary } = ended;
          return {
            content: [{ type: "text", text: formatSyncSummary(summary) }],
            // Partial failure is NOT an error result. A report that treats it
            // as one would abandon the run and say nothing, when three of four
            // banks did update. The warning at the top of the text is what
            // carries it. Total failure is a different matter.
            isError: summary.itemsTotal > 0 && summary.itemsSucceeded === 0,
          };
        }
        // Idle after a start: the app is quitting and the run was abandoned.
        return { content: [{ type: "text", text: stillRunning(started.startedAt, this.deps.now()) }] };
      },
    );
  }
}

/** Resolves with nothing after `ms`, and holds nothing open meanwhile. */
function after(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
}

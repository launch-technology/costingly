/**
 * sync_status — how the sync stands, without starting one.
 *
 * The model's counterpart of the Accounts screen's sync line: whether a sync
 * is running and since when, or the latest run with its times and each bank's
 * outcome. Read straight from the app's one sync service, so it is the same
 * run the screen shows, whoever started it. Held in memory for the app's
 * lifetime; after a restart there is nothing to report until something runs.
 */

import type { SyncService } from "../../features/sync/sync.service.js";
import { formatSyncStatus } from "../presenters/sync-report.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface SyncStatusDependencies {
  sync: Pick<SyncService, "state">;
  now(): Date;
}

export class SyncStatusTool implements Tool {
  readonly name = "sync_status";

  constructor(private readonly deps: SyncStatusDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Sync Status",
        description:
          "Whether a sync is running right now, and how the latest sync went: when it " +
          "started and finished, each bank's result, and any bank that failed or is " +
          "still being prepared by Plaid.\n\n" +
          "Call this after sync says a sync is still running, to get its result when it " +
          "finishes, or whenever you need to know how current the data is without " +
          "refreshing it. It starts nothing and changes nothing.\n\n" +
          "It remembers only since the Costingly app started. If no sync has run since " +
          "then, it says so; that is not an error.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({ content: [{ type: "text", text: formatSyncStatus(this.deps.sync.state(), this.deps.now()) }] }),
    );
  }
}

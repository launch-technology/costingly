/**
 * restart_database — stop the local server and bring it back.
 *
 * Through the app's database service, so it is queued with the Status
 * screen's own buttons and the screen shows Restarting while it runs. The
 * answer is the Database section as it stands afterwards, in the same words
 * the screen uses: Running with its facts, or what went wrong and what to do.
 *
 * Deliberately a restart rather than a stop. Stopping is never the goal — it
 * is a step towards connecting again, and with the server stopped every other
 * tool here would fail. This completes the round trip and reports whether the
 * database actually came back.
 */

import type { DatabaseSectionView } from "../../../bridge/contract.js";
import type { Tool, ToolHost } from "./tool.js";

export interface RestartDatabaseDependencies {
  /** Stop the database and bring it back, after whatever it is already doing. Never rejects. */
  restart(): Promise<void>;
  /** The Database section as it is right now. */
  section(): Promise<DatabaseSectionView>;
}

export class RestartDatabaseTool implements Tool {
  readonly name = "restart_database";

  constructor(private readonly deps: RestartDatabaseDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Restart the Costingly Database",
        description:
          "Stop costingly's local PostgreSQL server and start it again, then confirm " +
          "it is reachable. This clears most connection failures — a server left in " +
          "a bad state, a stale connection after the machine slept, or two copies of " +
          "costingly having competed for the same database. It also starts a database " +
          "that is simply stopped.\n\n" +
          "Use it when check_costingly reports the database is not running or not " +
          "answering, or when tools keep failing with connection errors, and the user " +
          "asks you to. If check_costingly says the database is fine, this will not " +
          "help — the problem is elsewhere.\n\n" +
          "No data is lost: the database is on disk and is not touched. A sync that " +
          "happens to be running is interrupted, and resumes where it left off the " +
          "next time it runs. Takes a few seconds; the Costingly app's Status screen " +
          "shows it happening.",
        inputSchema: {},
        annotations: {
          // Stops and starts a server process.
          readOnlyHint: false,
          // Nothing stored is altered or deleted. The only casualty is an
          // in-flight sync, which resumes from its cursor.
          destructiveHint: false,
          // Restarting twice leaves the same state as restarting once.
          idempotentHint: true,
          // Local process only.
          openWorldHint: false,
        },
      },
      async () => {
        await this.deps.restart();
        const section = await this.deps.section();
        if (section.problem !== undefined) {
          return {
            content: [
              {
                type: "text",
                text: `The database was restarted but is not usable. ${section.problem.cause}\n\n${section.problem.nextStep}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Restarted the database. ${section.headline}. ${section.details.join(" ")}\n\nRetry whatever failed before.`,
            },
          ],
        };
      },
    );
  }
}

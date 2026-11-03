/**
 * setup_costingly — create the local database.
 *
 * Through the same step first-run setup and the Status screen's Create
 * database button use, so it is queued with them and a failure is explained
 * in the same words. It does not configure Plaid: the keys are the person's
 * to enter on the Settings screen, and a successful setup routinely leaves
 * them still missing.
 */

import type { Problem } from "../../../bridge/contract.js";
import type { Tool, ToolHost } from "./tool.js";

export interface SetupCostinglyDependencies {
  /**
   * Create the database and bring it up. Resolves with what went wrong,
   * already explained, or with nothing when it worked. Safe to call on a
   * database that exists: it checks and changes nothing.
   */
  createDatabase(): Promise<Problem | undefined>;
  /** Are both Plaid keys in place? */
  keysPresent(): boolean;
}

export class SetupCostinglyTool implements Tool {
  readonly name = "setup_costingly";

  constructor(private readonly deps: SetupCostinglyDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Set Up Costingly",
        description:
          "Create costingly's local database on this machine. Call this when " +
          "check_costingly reports that costingly is not set up and the user asks you " +
          "to set it up.\n\n" +
          "It creates a PostgreSQL database in the user's own profile directory and " +
          "applies the schema — the same step the Costingly app's own setup performs. " +
          "Takes up to half a minute the first time. Safe to call again — on a working " +
          "install it checks and changes nothing.\n\n" +
          "IT DOES NOT CONFIGURE PLAID. Connecting a bank needs a Plaid client ID and " +
          "secret, which only the user can supply, on the Costingly app's Settings " +
          "screen. So a successful setup routinely leaves those still missing, and that " +
          "is not a failure — run check_costingly afterwards to see what remains.\n\n" +
          "Do not call this speculatively. It writes a database to the user's disk; " +
          "if a tool failed for some other reason, check_costingly says so.",
        inputSchema: {},
        annotations: {
          // Creates a database on the user's machine. Not destructive — it
          // never removes anything — but emphatically not read-only.
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const problem = await this.deps.createDatabase();
        if (problem !== undefined) {
          return {
            content: [{ type: "text", text: `Setup failed. ${problem.cause}\n\n${problem.nextStep}` }],
            isError: true,
          };
        }
        const keys = this.deps.keysPresent()
          ? "Plaid keys are already in place."
          : "Plaid keys are not entered yet. The user enters both the client ID and the secret on " +
            "Costingly's Settings screen; nothing needs restarting afterwards.";
        return {
          content: [
            {
              type: "text",
              text:
                "Costingly's database is set up and running.\n\n" +
                `${keys}\n\n` +
                "Run check_costingly to see whether anything else is still needed.",
            },
          ],
        };
      },
    );
  }
}

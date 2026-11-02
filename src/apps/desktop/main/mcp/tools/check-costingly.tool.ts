/**
 * check_costingly — is costingly usable, and if not, what is stopping it?
 *
 * Built to answer when everything else is down: that is the case it exists
 * for. Everything here is also the Status screen, rendered for a different
 * reader.
 *
 * Its advice points at the app. The model talking to this endpoint is talking
 * to a person who has Costingly installed and open, so what is wrong is fixed
 * there — keys on the Settings screen, the database on the Status screen,
 * setup in its own flow — and no tool here does any of it.
 */

import type { Blocker, CostinglyStatus } from "../../../../../domain/services/status.service.js";
import { formatCheck } from "../presenters/check-costingly.presenter.js";
import type { Tool, ToolHost } from "./tool.js";

export interface CheckCostinglyDependencies {
  /** The status and what is blocking it. The domain documents this never to throw. */
  check(): Promise<{ status: CostinglyStatus; blockers: Blocker[] }>;
}

export class CheckCostinglyTool implements Tool {
  readonly name = "check_costingly";

  constructor(private readonly deps: CheckCostinglyDependencies) {}

  register(host: ToolHost): void {
    host.registerTool(
      this.name,
      {
        title: "Check Costingly",
        description:
          "Whether costingly is set up and working, and what is stopping it if not. " +
          "Reports three things: the profile directory in use, the local database " +
          "(created? running? reachable? which migrations?), and Plaid (are " +
          "credentials present, and does the API answer).\n\n" +
          "Call this when any other costingly tool fails, or when the user says " +
          "costingly is broken, not working, or not set up. It is built to answer " +
          "when everything else is down — that is the case it exists for.\n\n" +
          "It distinguishes states that need different responses, and EVERY ONE OF " +
          "THEM IS FIXED BY THE USER IN THE COSTINGLY APP, not by a tool. NOT SET UP " +
          "means nothing has been created yet: the user finishes setup in Costingly. " +
          "NOT RUNNING means the database exists but its server is down: the user " +
          "presses Start in the Database section of Costingly's Status screen. NO " +
          "PLAID CREDENTIALS means no keys have been entered: the user enters both the " +
          "client ID and the secret on Costingly's Settings screen, where they take " +
          "effect at once with nothing to restart. Tell the user which it is and what " +
          "to do; retrying before they have will produce this same answer.\n\n" +
          "It reports on costingly, not on the user's money. It returns no " +
          "transactions, balances or totals: for those use query, and for the views " +
          "and columns needed to write one use describe_database.\n\n" +
          "The profile line is worth reading even when everything works. Costingly " +
          "supports several profiles and only one is active, so it is also the " +
          'answer to "why is costingly showing me different data than I expect".',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          // Reads this machine's own files and database. The Plaid check is
          // one small API call, so this is not strictly closed-world.
          openWorldHint: true,
        },
      },
      async () => {
        // The check is documented never to throw; a try/catch here anyway,
        // because a health tool that fails is a contradiction and the
        // guarantee is worth belt and braces.
        try {
          const { status, blockers } = await this.deps.check();
          return { content: [{ type: "text", text: formatCheck(status, blockers) }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text:
                  `The check itself failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
                  "That should not be possible. Tell the user to open Costingly's Status screen, which " +
                  "shows the same facts and offers what can be done about them.",
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
}

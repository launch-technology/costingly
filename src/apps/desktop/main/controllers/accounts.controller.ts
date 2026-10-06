/**
 * The Accounts screen's calls: the linked banks and their accounts, and
 * unlinking one of them.
 *
 * Linking and reconnecting a bank are the link controller's; syncing is the
 * sync controller's.
 */

import {
  presentAccounts,
  presentUnlinkPreview,
  presentUnlinkResult,
} from "../presenters/accounts.presenter.js";
import type { AccountsService } from "../services/accounts.service.js";
import type { UnlinkService } from "../services/unlink.service.js";
import type { Controller, HandlersFor } from "./controller.js";

export class AccountsController implements Controller<"accounts"> {
  constructor(
    private readonly accounts: AccountsService,
    private readonly unlinking: UnlinkService,
  ) {}

  handlers(): HandlersFor<"accounts"> {
    return {
      "accounts.list": async () => presentAccounts(await this.accounts.read()),

      "accounts.unlinkPreview": async (bankId) =>
        // The types say a string, but this is a process boundary. Anything
        // else names no bank, which is an answer the service already has.
        presentUnlinkPreview(await this.unlinking.preview(typeof bankId === "string" ? bankId : "")),

      "accounts.unlink": async (bankId, removeAtPlaid) => {
        // Only an explicit `false` means "leave it at Plaid". Anything unclear
        // takes the careful path, which stops if Plaid cannot remove the bank.
        const revokeAtPlaid = removeAtPlaid !== false;
        const attempt = await this.unlinking.unlink(typeof bankId === "string" ? bankId : "", { revokeAtPlaid });
        return presentUnlinkResult(attempt, revokeAtPlaid);
      },
    };
  }
}

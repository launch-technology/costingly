/**
 * The Accounts screen's one call: the linked banks and their accounts.
 *
 * Read-only. Linking a bank is the link controller's.
 */

import { presentAccounts } from "../presenters/accounts.presenter.js";
import type { AccountsService } from "../services/accounts.service.js";
import type { Controller, HandlersFor } from "./controller.js";

export class AccountsController implements Controller<"accounts"> {
  constructor(private readonly accounts: AccountsService) {}

  handlers(): HandlersFor<"accounts"> {
    return {
      "accounts.list": async () => presentAccounts(await this.accounts.read()),
    };
  }
}

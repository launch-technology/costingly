/**
 * The Settings screen's calls: read the settings, and change start-at-sign-in.
 *
 * Changing the Plaid keys is not here. It is `setup.submitKeys`, the same
 * check-with-Plaid-then-save that first-run setup uses, called from the
 * Settings screen as it is.
 */

import type { Controller, HandlersFor } from "../../shared/controller.js";
import { presentSettings, presentStartAtSignIn } from "./settings.presenter.js";
import type { SettingsService } from "./settings.service.js";
import type { StartAtSignInService } from "./start-at-sign-in.service.js";

export class SettingsController implements Controller<"settings"> {
  constructor(
    private readonly settings: SettingsService,
    private readonly startAtSignIn: StartAtSignInService,
  ) {}

  handlers(): HandlersFor<"settings"> {
    return {
      "settings.read": async () => presentSettings(this.settings.read()),

      // A process boundary: only an explicit `true` turns it on. Anything
      // unclear is "off", which is the setting that changes nothing lasting.
      "settings.setStartAtSignIn": async (on) => presentStartAtSignIn(this.startAtSignIn.set(on === true)),
    };
  }
}

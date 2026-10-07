/**
 * The Settings screen's facts, gathered.
 *
 * Settings is a screen with no store of its own. The Plaid keys live in the
 * profile's config file and are changed through the same check-and-save that
 * first-run setup uses (setup.service.ts). Start at sign-in lives in Windows
 * (start-at-sign-in.service.ts). The version and the data folder are read
 * from where they already are. This puts them on one plate.
 *
 * Reads only. Never throws: keys that cannot be read are reported as a
 * reason, for the presenter to word, and the rest of the plate is still
 * served.
 */

import type { StartAtSignInService } from "./start-at-sign-in.service.js";

export interface SettingsDependencies {
  /** The Plaid client ID saved in the profile, or null when none is. Never the secret. */
  plaidClientId(): string | null;
  version(): string;
  /** The profile directory, shortened for display. */
  dataFolder(): string;
  startAtSignIn: Pick<StartAtSignInService, "isOn">;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export interface SettingsReading {
  /** The saved client ID; null when none is saved, or when the keys could not be read. */
  plaidClientId: string | null;
  /** Why the keys could not be read, when they could not. */
  plaidKeysUnreadable?: string;
  startAtSignIn: boolean;
  version: string;
  dataFolder: string;
}

export class SettingsService {
  constructor(private readonly deps: SettingsDependencies) {}

  read(): SettingsReading {
    let plaidClientId: string | null = null;
    let plaidKeysUnreadable: string | undefined;
    try {
      plaidClientId = this.deps.plaidClientId();
    } catch (error) {
      plaidKeysUnreadable = this.deps.describeError(error);
    }

    return {
      plaidClientId,
      ...(plaidKeysUnreadable === undefined ? {} : { plaidKeysUnreadable }),
      startAtSignIn: this.deps.startAtSignIn.isOn(),
      version: this.deps.version(),
      dataFolder: this.deps.dataFolder(),
    };
  }
}

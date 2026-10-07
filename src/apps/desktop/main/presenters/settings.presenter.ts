/**
 * The Settings screen, worded. Pure functions, like the other presenters.
 *
 * The facts arrive as facts and pass through. What is worded here is each
 * way something went wrong: keys that could not be read, and a change to
 * start-at-sign-in that did not take — the latter with what Windows has now,
 * so the switch can show the truth.
 */

import type { SettingsView, StartAtSignInResult } from "../../bridge/contract.js";
import type { SettingsReading } from "../services/settings.service.js";
import type { StartAtSignInChange } from "../services/start-at-sign-in.service.js";

export function presentSettings(reading: SettingsReading): SettingsView {
  const { plaidKeysUnreadable, ...facts } = reading;
  if (plaidKeysUnreadable === undefined) return facts;
  return {
    ...facts,
    plaidProblem: {
      cause: `The saved Plaid keys could not be read: ${plaidKeysUnreadable}`,
      nextStep: "Enter your keys below to save them again.",
    },
  };
}

export function presentStartAtSignIn(change: StartAtSignInChange): StartAtSignInResult {
  if (change.changed) return { outcome: "set", on: change.on };
  return {
    outcome: "failed",
    on: change.on,
    problem: {
      cause: `The start-at-sign-in setting could not be changed: ${change.reason}`,
      nextStep: "Try again. If it keeps happening, your Windows account may not allow apps to register themselves to start at sign-in.",
    },
  };
}

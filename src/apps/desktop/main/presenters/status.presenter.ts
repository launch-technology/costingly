/**
 * The status reports, worded for a person looking at a window.
 *
 * The domain's reports carry facts plus the odd terminal-flavoured hint
 * ("run `costingly init`"). Those hints are the CLI's wording, not ours — the
 * same fact reads differently in a window with a button than at a prompt — so
 * this reads the facts and says each state in its own words. Pure functions
 * over plain objects, which is what makes every state a table entry in
 * tests/desktop-status-presenter.test.mts rather than a database to build and
 * break. They stay functions: there is no state here and nothing to inject.
 *
 * The profile and the Plaid keys are here. The database has more to say — what
 * is wrong, and what to press — and has its own file, database.presenter.ts.
 */

import type { PlaidStatus, ProfileStatus } from "../../../../domain/services/status.service.js";
import type { SectionView } from "../../bridge/contract.js";

export function presentProfile(profile: ProfileStatus): SectionView {
  const where = `Data folder: ${profile.path}`;
  // Only worth saying when something other than the default chose it — that is
  // the case where a person is looking at a profile they did not expect.
  const chosen =
    profile.chosenBy === "platform default" ? [] : [`Location chosen by ${profile.chosenBy}`];

  if (!profile.exists) {
    return {
      tone: "neutral",
      headline: "Not set up",
      details: ["No data folder has been created yet.", where, ...chosen],
    };
  }

  return {
    tone: "good",
    headline: "Set up",
    details: [
      where,
      ...chosen,
      profile.config.exists ? "Settings file present." : "No settings file yet.",
    ],
  };
}

export function presentPlaid(plaid: PlaidStatus): SectionView {
  if (!plaid.configured) {
    return {
      tone: "neutral",
      headline: "No keys entered",
      details: ["Plaid keys have not been entered yet."],
    };
  }

  if (plaid.reachable) {
    return {
      tone: "good",
      headline: "Keys present and working",
      details: ["Plaid accepted these keys."],
    };
  }

  return {
    tone: "warn",
    headline: "Keys present but Plaid could not be reached",
    details: [plaid.error ?? "Plaid did not respond."],
  };
}

/**
 * A check that threw instead of reporting.
 *
 * The checks are written never to throw, so reaching this means something
 * outside their contract went wrong. It is still shown as a section outcome,
 * not an error dialog: one section failing must leave the other two readable.
 */
export function couldNotCheck(error: unknown): SectionView {
  return {
    tone: "bad",
    headline: "Could not check",
    details: [error instanceof Error ? error.message : String(error)],
  };
}

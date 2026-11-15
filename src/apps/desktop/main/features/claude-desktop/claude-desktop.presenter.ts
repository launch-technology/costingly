/**
 * The Claude Desktop screen's view, worded. Pure functions, like the other
 * presenters; every state is a table entry in
 * tests/desktop-claude-desktop-presenter.test.mts.
 *
 * The version rule is platform/version.ts, the same one the extension applies
 * before relaying, so the screen and the extension never disagree about
 * whether the two work together.
 */

import { compatible } from "../../../../../platform/version.js";
import type { ClaudeDesktopView, Problem } from "../../../bridge/contract.js";
import type { ExtensionFile } from "./claude-desktop.adapter.js";
import type { ExtensionSighting } from "./extension-presence.service.js";

export function presentClaudeDesktop(file: ExtensionFile, lastSeen: ExtensionSighting | undefined, appVersion: string): ClaudeDesktopView {
  return {
    appVersion,
    file,
    connection:
      lastSeen === undefined
        ? { state: "never" }
        : { state: "heard", at: lastSeen.at.toISOString(), version: lastSeen.version, compatible: compatible(lastSeen.version, appVersion) },
  };
}

/** The folder could not be opened; the path is given so the user can get there by hand. */
export function openFailed(path: string, reason: string): Problem {
  return {
    cause: `The folder could not be opened: ${reason}`,
    nextStep: `Open it by hand. The file is ${path}`,
  };
}

/** Open folder pressed with no file to show. */
export function nothingToOpen(folder: string, buildCommand: string): Problem {
  return {
    cause: `There is no extension file in ${folder}.`,
    nextStep: `Run ${buildCommand} in the repository, then try again.`,
  };
}

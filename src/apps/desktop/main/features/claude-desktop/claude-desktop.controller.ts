/**
 * The Claude Desktop screen's calls: how things stand, and open the folder.
 *
 * The folder is opened by Electron's shell, handed in by the application as
 * the clipboard is to the Connect controller, so this runs without a window.
 * A folder that cannot be opened is a result carrying the file's path, not a
 * rejected call: the user can still get there by hand.
 */

import type { ClaudeDesktopView, OpenFolderOutcome } from "../../../bridge/contract.js";
import type { Controller, HandlersFor } from "../../shared/controller.js";
import type { ExtensionFile } from "./claude-desktop.adapter.js";
import { nothingToOpen, openFailed, presentClaudeDesktop } from "./claude-desktop.presenter.js";
import type { ExtensionPresenceService } from "./extension-presence.service.js";

export interface ClaudeDesktopDependencies {
  presence: ExtensionPresenceService;
  /** Where the extension file is right now. Asked each time: a developer may have just built it. */
  locate(): ExtensionFile;
  appVersion(): string;
  /** Show a file in its folder. Electron's, handed in. */
  showInFolder(path: string): void;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export class ClaudeDesktopController implements Controller<"claudeDesktop"> {
  constructor(private readonly deps: ClaudeDesktopDependencies) {}

  handlers(): HandlersFor<"claudeDesktop"> {
    return {
      "claudeDesktop.read": async (): Promise<ClaudeDesktopView> =>
        presentClaudeDesktop(this.deps.locate(), this.deps.presence.lastSeen(), this.deps.appVersion()),

      "claudeDesktop.openFolder": async (): Promise<OpenFolderOutcome> => {
        const file = this.deps.locate();
        if (file.state === "missing") return { outcome: "failed", problem: nothingToOpen(file.folder, file.buildCommand) };
        try {
          this.deps.showInFolder(file.path);
          return { outcome: "opened" };
        } catch (error) {
          return { outcome: "failed", problem: openFailed(file.path, this.deps.describeError(error)) };
        }
      },
    };
  }
}

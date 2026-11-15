/**
 * The About screen's one call: what this program is.
 *
 * Facts shown as facts; nothing here is worded, so there is no presenter. The
 * facts are read on every call rather than once at start, which costs nothing
 * and means the screen can never show a version the file no longer says.
 */

import type { PackageInfo } from "../../../../../platform/package.js";
import type { AboutView } from "../../../bridge/contract.js";
import type { Controller, HandlersFor } from "../../shared/controller.js";

export interface AboutDependencies {
  info(): PackageInfo;
  /** The profile directory, shortened for display. */
  dataFolder(): string;
}

export class AboutController implements Controller<"about"> {
  constructor(private readonly deps: AboutDependencies) {}

  handlers(): HandlersFor<"about"> {
    return {
      "about.read": async (): Promise<AboutView> => ({ ...this.deps.info(), dataFolder: this.deps.dataFolder() }),
    };
  }
}

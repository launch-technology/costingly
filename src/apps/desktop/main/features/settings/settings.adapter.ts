/**
 * The Settings screen's wiring: the real domain, fitted to what the settings
 * service asks for. WIRING ONLY — the config file, the version and the data
 * folder, read as they are. The sign-in registration is Electron's and is
 * supplied by the composition root; no Electron here.
 */

import { readConfigFile } from "../../../../../domain/config.js";
import { platform } from "../../../../../domain/project.js";
import { packageVersion } from "../../../../../platform/package.js";
import { describeError } from "../../shared/domain.adapter.js";
import type { SettingsDependencies } from "./settings.service.js";

/**
 * What the Settings screen shows, except the sign-in registration, which is
 * Electron's and the app supplies.
 *
 * The client ID is read from the config FILE, not through the resolver that
 * also looks at environment variables: the screen shows what is saved, which
 * is what the keys form changes.
 *
 * The version is costingly's own, from package.json, the same one the CLI
 * prints. Electron's `app.getVersion()` is Electron's own version when the
 * app runs from source, and only becomes ours once packaged.
 */
export function settingsDependencies(): Pick<SettingsDependencies, "plaidClientId" | "version" | "dataFolder" | "describeError"> {
  return {
    plaidClientId: () => {
      const saved = readConfigFile().plaidClientId;
      return typeof saved === "string" && saved.trim() !== "" ? saved : null;
    },
    version: packageVersion,
    dataFolder: () => platform.displayPath(platform.profileDir()),
    describeError,
  };
}

/**
 * The Settings screen's wiring: the real domain, fitted to what the settings
 * service asks for. WIRING ONLY — the config file, read as it is. The sign-in
 * registration is Electron's and is supplied by the composition root; no
 * Electron here.
 */

import { readConfigFile } from "../../../../../domain/config.js";
import { describeError } from "../../shared/domain.adapter.js";
import type { SettingsDependencies } from "./settings.service.js";

/**
 * What the Settings screen shows, except the sign-in registration, which is
 * Electron's and the app supplies.
 *
 * The client ID is read from the config file as saved, which is what the keys
 * form changes.
 */
export function settingsDependencies(): Pick<SettingsDependencies, "plaidClientId" | "describeError"> {
  return {
    plaidClientId: () => {
      const saved = readConfigFile().plaidClientId;
      return typeof saved === "string" && saved.trim() !== "" ? saved : null;
    },
    describeError,
  };
}

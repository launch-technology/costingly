/**
 * The Windows "start at sign-in" registration, through Electron.
 *
 * Electron writes it to the current user's Run key in the registry, under
 * REGISTRATION_NAME, as the running executable plus LAUNCH_ARGS. Three things
 * were learned by trying it, and this file is built on them:
 *
 *   THE NAME IS GIVEN EXPLICITLY. Left to Electron it is derived from the
 *   executable — "electron.app.Electron" when run from source, something
 *   else when installed. One fixed name means the uninstaller knows what to
 *   delete (see installer/installer.nsh), whatever built the registration.
 *
 *   IT IS READ THROUGH THE LAUNCH ITEMS, BY NAME. Electron's summary flag
 *   (`openAtLogin`) does not report a registration made under a given name;
 *   the list of launch items does, each with its registry name. So that is
 *   what is checked.
 *
 *   THE ARGUMENT IS HOW THE APP KNOWS IT WAS STARTED AT SIGN-IN. Launched with
 *   LAUNCH_ARGS, the app brings everything up but shows no window — it is
 *   sign-in, and nobody asked to look at it (see desktop.application.ts).
 */

import { app } from "electron";

import type { StartAtSignInDependencies } from "../services/start-at-sign-in.service.js";

/** The registry value's name. installer/installer.nsh deletes this exact name on uninstall. */
export const REGISTRATION_NAME = "Costingly";
/** What the registration launches the app with. */
export const LAUNCH_ARGS = ["--hidden"];

export function startedHidden(argv: readonly string[]): boolean {
  return LAUNCH_ARGS.every((flag) => argv.includes(flag));
}

/** Electron's reading and writing of the registration, as the service wants them. */
export function startAtSignInRegistration(): Pick<StartAtSignInDependencies, "registered" | "register"> {
  return {
    registered: () =>
      app
        .getLoginItemSettings({ args: LAUNCH_ARGS })
        .launchItems.some((item) => item.name === REGISTRATION_NAME && item.enabled),
    register: (on) => app.setLoginItemSettings({ openAtLogin: on, name: REGISTRATION_NAME, args: LAUNCH_ARGS }),
  };
}

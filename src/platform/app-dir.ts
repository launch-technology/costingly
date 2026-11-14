/**
 * Where an application keeps what is its own, as opposed to the profile's.
 *
 * The profile is the project's data: config, cluster, log. An application
 * that sits beside it — a desktop app with a window cache and a settings file,
 * an extension that needs to find that app — also needs somewhere to look,
 * and that must NOT be inside the profile, because opening an application
 * must never create a profile. A machine where nothing is set up has to stay
 * looking that way.
 *
 * So the application gets a sibling of the profile:
 *
 *   <LOCALAPPDATA>\<project>\Data\       the profile
 *   <LOCALAPPDATA>\<project>\Desktop\    the application
 *
 * One parent, so uninstalling means deleting one folder. When the home
 * variable has moved the profile — development, tests — there is no
 * project-named parent to sit beside, and the application's folder follows
 * the profile with a suffix: `.dev-sandbox` and `.dev-sandbox-desktop`.
 *
 * Two programs read this folder: the desktop app, which owns it, and the
 * Claude Desktop extension, which only reads the connection file from it.
 * Both derive the location here, so they can never disagree about it.
 */

import { join } from "node:path";

import type { PlatformConfig } from "./platform-config.js";
import { projectParentOf } from "./profile.js";

/** The application's own folder for a profile. Never inside the profile. */
export function appDir(profile: PlatformConfig): string {
  const dir = profile.profileDir();
  const parent = projectParentOf(profile, dir);
  return parent === null ? `${dir}-desktop` : join(parent, "Desktop");
}

/**
 * Where a local MCP client reaches the application: the endpoint's last port
 * and its token (connection-file.ts). Beside the application's other files,
 * not in the profile: the endpoint runs before setup, and must create nothing
 * of the profile's.
 */
export function connectionPath(profile: PlatformConfig): string {
  return join(appDir(profile), "mcp.json");
}

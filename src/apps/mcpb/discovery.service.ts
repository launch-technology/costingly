/**
 * Where the Costingly app is: its endpoint's address and the token it requires.
 *
 * Two sources, in this order:
 *
 *   1. The extension's own settings in Claude Desktop — Address and Token —
 *      which Claude Desktop hands this process as environment variables.
 *      Both are optional, blank by default, and exist for the one case where
 *      the second source cannot be used. A filled-in setting always wins.
 *   2. What the app writes down for local clients: the port it last listened
 *      on and its token, in the app's own folder beside the profile.
 *
 * Asked again before every retry, never cached: the app may have restarted
 * on another port since the last request, and the file is where it says so.
 *
 * A blank setting is one Claude Desktop passed as the unfilled placeholder
 * `${user_config.name}` — measured on a real install, that is what an empty
 * field becomes — or an empty string. Either means "not set".
 */

import type { Connection } from "../../platform/connection-file.js";

export interface Settings {
  address?: string;
  token?: string;
}

export interface Endpoint {
  /** The full address of the app's MCP endpoint. */
  url: string;
  token: string;
  /** Where the address came from; a dead address from the settings is worded differently. */
  addressFrom: "settings" | "app";
}

export type Discovery =
  | { found: true; endpoint: Endpoint }
  /** The app has written nothing down and the settings do not say: never opened, or not installed. */
  | { found: false; reason: "never-opened" }
  /** Something is written down or set, but not enough to connect with. */
  | { found: false; reason: "unreadable" };

export interface DiscoveryDependencies {
  settings(): Settings;
  /** The app's connection file: absent, or whatever it holds (empty when unreadable). */
  connection(): Promise<"absent" | Connection>;
}

export class DiscoveryService {
  constructor(private readonly deps: DiscoveryDependencies) {}

  async discover(): Promise<Discovery> {
    const settings = this.deps.settings();
    const connection = await this.deps.connection();
    const written = connection === "absent" ? {} : connection;

    const url = settings.address ?? (written.port === undefined ? undefined : `http://127.0.0.1:${written.port}/mcp`);
    const token = settings.token ?? written.token;

    if (url !== undefined && token !== undefined) {
      return { found: true, endpoint: { url, token, addressFrom: settings.address === undefined ? "app" : "settings" } };
    }
    if (connection === "absent" && settings.address === undefined && settings.token === undefined) {
      return { found: false, reason: "never-opened" };
    }
    return { found: false, reason: "unreadable" };
  }
}

/** The two settings, as Claude Desktop passes them. */
export const SETTINGS_VARIABLES = { address: "COSTINGLY_ADDRESS", token: "COSTINGLY_TOKEN" } as const;

export function settingsFromEnvironment(env: NodeJS.ProcessEnv = process.env): Settings {
  const address = filled(env[SETTINGS_VARIABLES.address]);
  const token = filled(env[SETTINGS_VARIABLES.token]);
  return { ...(address === undefined ? {} : { address }), ...(token === undefined ? {} : { token }) };
}

/** A value that was actually entered: not empty, and not an unfilled `${...}` placeholder. */
function filled(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || /^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

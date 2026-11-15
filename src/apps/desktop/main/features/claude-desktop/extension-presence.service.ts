/**
 * Whether the Claude Desktop extension has spoken to this app, and when.
 *
 * The extension names itself on every request (`costingly-mcpb/2.0.0`, in a
 * header the endpoint reads). This remembers the latest such request and
 * nothing else: not what was asked, not whether it worked. One record, in
 * memory, so "connected" means "heard from since Costingly started" and
 * starts over with the app — a record from a previous session would say
 * connected about a Claude Desktop that may have quit since.
 *
 * Only the extension counts. Any other client that names itself is somebody
 * else's business and is not recorded here.
 */

/** What the extension sends as its name. Set in apps/mcpb/main.ts; the app may not import it from there. */
export const EXTENSION_CLIENT_NAME = "costingly-mcpb";

export interface ExtensionSighting {
  version: string;
  at: Date;
}

export class ExtensionPresenceService {
  private latest: ExtensionSighting | undefined;

  /** A request carrying a client's self-description arrived at `at`. */
  record(client: string, at: Date): void {
    const parsed = parseClient(client);
    if (parsed === undefined || parsed.name !== EXTENSION_CLIENT_NAME) return;
    this.latest = { version: parsed.version, at };
  }

  /** The latest request from the extension, or undefined when there has been none since the app started. */
  lastSeen(): ExtensionSighting | undefined {
    return this.latest;
  }
}

/** `name/version`, split at the last slash so a version may not hide one. */
function parseClient(client: string): { name: string; version: string } | undefined {
  const slash = client.lastIndexOf("/");
  if (slash <= 0 || slash === client.length - 1) return undefined;
  return { name: client.slice(0, slash).trim(), version: client.slice(slash + 1).trim() };
}

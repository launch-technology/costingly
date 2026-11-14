/**
 * Everything the extension itself says to Claude, as opposed to what it
 * relays from the app.
 *
 * Each message names the cause and the one thing to do about it, pointing at
 * the Costingly app — its Start menu entry, its Connect screen — or at this
 * extension's own two settings when they are the fix. Never a command. Claude
 * Desktop is named only where restarting it is genuinely the step: its list
 * of tools is read once when it starts, and nothing here can refresh it.
 *
 * Pure functions; the suite checks every one.
 */

const WHAT_COSTINGLY_IS =
  "Costingly keeps the user's own bank and credit-card transactions in a database on this " +
  "machine, served by the Costingly desktop app. This extension only connects Claude " +
  "Desktop to that app.";

export const NEVER_OPENED =
  "Costingly does not seem to be installed on this machine, or has never been opened: " +
  "the app has left nothing for this extension to connect to.\n\n" +
  "Tell the user to install Costingly if they have not, open it from the Start menu, " +
  "and then restart Claude Desktop so its tools appear here. Nothing else will help.";

export const NOT_RUNNING_AT_START =
  "The Costingly app was not running when Claude Desktop started, so its tools are not " +
  "available in this session.\n\n" +
  "Tell the user to open Costingly from the Start menu and then restart Claude Desktop. " +
  "Claude Desktop reads an extension's tools only when it starts, so both steps are needed.";

export const NOT_RUNNING =
  "The Costingly app is not running, so this request could not be answered.\n\n" +
  "Tell the user to open Costingly from the Start menu, then try again. No restart of " +
  "Claude Desktop is needed.";

export const TOKEN_REJECTED =
  "The Costingly app refused the token this extension presented: it is not the app's " +
  "current token.\n\n" +
  "Tell the user to open Claude Desktop's settings for the Costingly extension and clear " +
  "the Token field, so the extension finds the app's token by itself — or to copy the " +
  "current token from Costingly's Connect screen into that field. Then try again.";

export const UNREADABLE =
  "This extension could not work out where the Costingly app is: what the app wrote down " +
  "for it could not be read.\n\n" +
  "Tell the user to open Costingly's Connect screen and copy the address and the token " +
  "into the Address and Token fields of this extension's settings in Claude Desktop, " +
  "then try again.";

export function addressUnreachable(address: string): string {
  return (
    `Nothing answered at ${address}, the address entered in this extension's settings.\n\n` +
    "Tell the user to open Costingly from the Start menu, and to check that address " +
    "against the one on Costingly's Connect screen; clearing the Address field lets the " +
    "extension find the app by itself. Then try again."
  );
}

export function incompatible(appVersion: string, ownVersion: string): string {
  const [app, own] = [appVersion, ownVersion].map((v) => Number(/^(\d+)/.exec(v)?.[1] ?? Number.NaN));
  const older = app !== undefined && own !== undefined && !Number.isNaN(app) && !Number.isNaN(own) && app < own ? "the Costingly app" : "this extension";
  return (
    `This extension (version ${ownVersion}) and the Costingly app (version ${appVersion}) are ` +
    `different major versions and do not work together. Nothing was sent to the app.\n\n` +
    `Tell the user to update ${older} so both are the same version: the app from where ` +
    "they installed it, the extension by installing the one built with the app."
  );
}

export function relayFailed(reason: string): string {
  return (
    `The Costingly app could not be asked: ${reason}\n\n` +
    "Tell the user to check the Status screen in Costingly, then try again."
  );
}

/** Appended to a relayed answer when Claude Desktop started without the app and so lists one tool. */
export const RESTART_TO_SEE_ALL =
  "\n\nThe Costingly app is running now, but Claude Desktop started before it did and so " +
  "lists only this tool. Tell the user to restart Claude Desktop to get all of Costingly's tools.";

/** The introduction Claude gets when the extension cannot relay the app's own. */
export function introduction(problem: string): string {
  return `${WHAT_COSTINGLY_IS}\n\n${problem}\n\nOne tool, check_costingly, is available meanwhile; it repeats this and says when the app is reachable.`;
}

/** The one tool offered when nothing can be relayed. */
export const CHECK_TOOL_DESCRIPTION =
  "Whether the Costingly app can be reached from Claude Desktop, and what to do if not. " +
  "Call it when the user asks about Costingly and no other Costingly tool is available, " +
  "or when another Costingly tool reported that the app is not running.";

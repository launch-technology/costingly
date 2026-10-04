/**
 * What crosses the process boundary between the main process and the window.
 *
 * Built in the main process from the domain's status reports, drawn by the
 * renderer. This file has NO imports on purpose: the renderer is browser code
 * and may not reach into node or the domain, so this is the one file both
 * sides are allowed to share.
 */

/** Drives the indicator beside the headline. Nothing else reads it. */
export type SectionTone = "neutral" | "good" | "warn" | "bad";

/** What one section of the status screen shows. */
export interface SectionView {
  tone: SectionTone;
  /** One short line a person reads first: "Running", "Not set up". */
  headline: string;
  /** Supporting facts, one line each. May be empty. */
  details: string[];
}

/** The three sections, in the order the screen shows them. */
export type SectionId = "profile" | "database" | "plaid";

/**
 * Everything the window can ask the main process for.
 *
 * Exposed by preload.cts as `window.costingly`; the renderer sees nothing else
 * of node, Electron or the domain. Each check is its own call so a slow one
 * (Plaid is a network round trip) never holds up the other two.
 */
export interface CostinglyApi {
  status: {
    profile(): Promise<SectionView>;
    database(): Promise<SectionView>;
    plaid(): Promise<SectionView>;
  };
  /**
   * Fires when the window comes back from the tray or to the front, so the
   * screen can re-check. Returns the unsubscribe.
   */
  onWindowShown(listener: () => void): () => void;
}

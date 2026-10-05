/**
 * The contract between the window and the main process.
 *
 * ONE PLACE says what the window may ask for and what it gets back. Both
 * sides are derived from it: the main process must supply a handler for every
 * entry in `DesktopContract` or it does not compile, and the window can only
 * make calls that are listed here, with these arguments. A call name is never
 * typed twice as a bare string that the compiler cannot check.
 *
 * Adding something the window can do is one line in `DesktopContract` and one
 * method on a controller. Nothing else — preload.cts does not change.
 *
 * This file has NO imports on purpose. The renderer is browser code and may
 * not reach into node or the domain, so this is the one file both sides of
 * the process boundary share, and it must stay loadable by either.
 */

// ---------------------------------------------------------------------------
// What the calls carry
// ---------------------------------------------------------------------------

/** Drives the indicator beside a headline. Nothing else reads it. */
export type SectionTone = "neutral" | "good" | "warn" | "bad";

/** What one section of the status screen shows. */
export interface SectionView {
  tone: SectionTone;
  /** One short line a person reads first: "Running", "Not set up". */
  headline: string;
  /** Supporting facts, one line each. May be empty. */
  details: string[];
}

/** The three status sections, in the order the screen shows them. */
export type SectionId = "profile" | "database" | "plaid";

/**
 * What first-run setup still has to do on this machine.
 *
 * Two facts, both read from disk with no network call: keys PRESENT (not keys
 * valid — being offline must never send a set-up user back to setup) and a
 * database CREATED (not running — a stopped database is still set up).
 */
export interface SetupState {
  keysPresent: boolean;
  databaseCreated: boolean;
  /** The profile directory, shortened for display. */
  dataFolder: string;
}

/**
 * What Plaid said about a pair of keys.
 *
 * `rejected` and `unreachable` are different problems with different fixes —
 * retype the keys, or check the network — so they are different outcomes and
 * not one "failed". Nothing is saved in either case.
 */
export type KeysResult =
  | { outcome: "accepted" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "unreachable"; reason: string };

/**
 * Something is wrong, said in two parts: what, and what to do about it.
 *
 * Always both. A cause with no next step leaves the reader where they started.
 */
export interface Problem {
  cause: string;
  nextStep: string;
}

/**
 * What the user can do to the database from the app.
 *
 * `update` brings the tables up to date (shown as "Retry" after a failed
 * update); `create` makes a database on a machine that has none.
 */
export type DatabaseAction = "start" | "stop" | "restart" | "update" | "create";

/**
 * The status screen's Database section: a section, plus what is wrong (if
 * anything) and which actions to offer. The main process decides both, so the
 * window never has to work out which button fits which state.
 */
export interface DatabaseSectionView extends SectionView {
  problem?: Problem;
  actions: DatabaseAction[];
}

/**
 * The end of the database's own log, for someone trying to see why it failed.
 *
 * `empty` and `unreadable` are answers, not errors: a database that has never
 * run has no log, and saying so beats showing an empty box.
 */
export type LogExcerpt =
  | { state: "lines"; lines: string[]; path: string }
  | { state: "empty"; path: string }
  | { state: "unreadable"; path: string };

export type DatabaseResult = { outcome: "ready" } | { outcome: "failed"; problem: Problem };

/** One account, as the Accounts screen shows it. Every field is ready to draw. */
export interface AccountView {
  id: string;
  name: string;
  /** "Checking", "Credit card" — or empty when the bank did not say. */
  type: string;
  /** The last four digits, or empty when the bank did not give them. */
  lastFour: string;
  /** "$1,234.56", or a dash when the bank reported no balance. */
  balance: string;
}

/** One bank login and the accounts under it. */
export interface BankView {
  id: string;
  name: string;
  /** Made-up data from the developer seed command, not a real bank. */
  sample: boolean;
  accounts: AccountView[];
}

/**
 * The Accounts screen.
 *
 * `database-stopped` is its own answer, not a failure: nothing is wrong with
 * the accounts, there is simply nothing to read them from right now, and the
 * fix is on another screen.
 */
export type AccountsView =
  | { state: "ready"; banks: BankView[]; /** When the balances were written, and what they are not. */ note: string }
  | { state: "database-stopped" }
  | { state: "failed"; problem: Problem };

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/**
 * Everything the window can ask the main process for.
 *
 * Named `<feature>.<call>`; the feature is which controller answers it. Each
 * status check is its own call so a slow one (Plaid is a network round trip)
 * never holds up the other two.
 */
export interface DesktopContract {
  "status.profile": { args: []; result: SectionView };
  "status.database": { args: []; result: DatabaseSectionView };
  "status.plaid": { args: []; result: SectionView };

  /**
   * Each action runs to completion and answers with the Database section as it
   * is afterwards — so a failure comes back as a section that explains it, not
   * as a rejected call.
   */
  "database.start": { args: []; result: DatabaseSectionView };
  "database.stop": { args: []; result: DatabaseSectionView };
  "database.restart": { args: []; result: DatabaseSectionView };
  "database.update": { args: []; result: DatabaseSectionView };
  "database.create": { args: []; result: DatabaseSectionView };
  "database.logExcerpt": { args: []; result: LogExcerpt };

  "setup.state": { args: []; result: SetupState };
  /** The secret goes in and never comes back, in any outcome. */
  "setup.submitKeys": { args: [clientId: string, secret: string]; result: KeysResult };
  "setup.createDatabase": { args: []; result: DatabaseResult };
  /** Opens Plaid's own site in the default browser. Takes no address. */
  "setup.openPlaidSite": { args: []; result: void };
  /** Opens Plaid's keys page in the default browser. Takes no address. */
  "setup.openPlaidKeysPage": { args: []; result: void };

  "accounts.list": { args: []; result: AccountsView };

  /**
   * Linking a bank happens in the user's own browser: this opens costingly's
   * local link page there. Takes no address. Answers once the browser has
   * been asked to open — the linking itself is out of the app's sight, and
   * the Accounts screen finds the result when it is next looked at.
   *
   * Not in an app window, by decision: some banks' fraud screening refuses a
   * login from anything but a real browser, and says nothing when it does.
   */
  "link.openInBrowser": { args: []; result: void };
}

export type Call = keyof DesktopContract;
export type CallArgs<K extends Call> = DesktopContract[K]["args"];
export type CallResult<K extends Call> = DesktopContract[K]["result"];

/**
 * Everything the main process can tell the window, unasked.
 *
 * `window.shown` fires when the window comes back from the tray or to the
 * front, so a screen can re-check what it is showing.
 */
export interface DesktopEvents {
  "window.shown": [];
}

export type DesktopEvent = keyof DesktopEvents;

/**
 * What preload.cts puts on `window.costingly`: the whole of the window's
 * access to the rest of the app. Two functions, typed by the contract above.
 */
export interface Bridge {
  invoke<K extends Call>(call: K, ...args: CallArgs<K>): Promise<CallResult<K>>;
  /** Subscribe to an event. Returns the unsubscribe. */
  on<E extends DesktopEvent>(event: E, listener: (...args: DesktopEvents[E]) => void): () => void;
}

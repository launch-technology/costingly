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
  /** "Last synced Oct 4, 2026, 8:03 PM", "Not synced yet" — or empty for sample data, which is never synced. */
  lastSynced: string;
  /**
   * The bank login has expired. The bank is skipped by every sync until the
   * user reconnects it.
   */
  needsAttention: boolean;
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
  | {
      state: "ready";
      banks: BankView[];
      /** When the balances were written. Empty with no balances to speak of. */
      note: string;
      /** There is at least one real bank a sync would refresh. */
      canSync: boolean;
    }
  | { state: "database-stopped" }
  | { state: "failed"; problem: Problem };

/**
 * What unlinking a bank would do, shown before it is done.
 *
 * Read by the main process from the bank's id: the window never supplies the
 * name or the counts it then displays.
 */
export type UnlinkPreview =
  | {
      state: "found";
      bankName: string;
      /** What the user types to confirm: the bank's name, or "unlink" for a bank with none. */
      confirmWord: string;
      /** "2 accounts and 250 transactions will be deleted from this computer." */
      summary: string;
      /** False for sample data, which has nothing at Plaid to remove. */
      atPlaid: boolean;
    }
  /** The bank cannot be unlinked right now, or is not there. */
  | { state: "unavailable"; problem: Problem };

/** How an unlink ended. */
export type UnlinkResult =
  | { outcome: "unlinked"; /** What was done, in a sentence or two. */ message: string }
  /** Plaid would not remove it. Nothing was deleted; it can be tried again, or unlinked here only. */
  | { outcome: "plaid-failed"; problem: Problem }
  | { outcome: "failed"; problem: Problem };

/** What the latest sync did for one bank, in one line. */
export interface BankSyncResult {
  bankId: string;
  tone: SectionTone;
  text: string;
}

/**
 * The sync, as the Accounts screen shows it.
 *
 * A sync belongs to the app, not to a screen: it is started, runs in the
 * background, and finishes whether or not anyone is looking. This is what a
 * screen sees when it asks, or is told — the same whoever started the sync.
 *
 * Only the latest run is kept. `finished` stays until the next run starts or
 * the app is restarted.
 */
export type SyncView =
  | { state: "idle" }
  | { state: "running" }
  | {
      state: "finished";
      tone: SectionTone;
      /** One line for the whole run: "Synced 2 banks." */
      summary: string;
      /** Set when the run failed as a whole, or every bank failed the same way. */
      problem?: Problem;
      results: BankSyncResult[];
    };

/**
 * What the Transactions screen is asking to see.
 *
 * Dates are calendar days as "YYYY-MM-DD", exactly as a date field holds
 * them, or empty for no bound. Nothing here is a span like "last 30 days":
 * the window sends the days it was given and nobody works one out.
 */
export interface TransactionsQuery {
  /** One account's id, or empty for every account. */
  accountId: string;
  from: string;
  to: string;
  /** Text to find in the description or merchant name. Empty for none. */
  text: string;
  /** How many of the newest matches to show. */
  limit: number;
}

/** One transaction, as the Transactions screen shows it. Every field is ready to draw. */
export interface TransactionRowView {
  id: string;
  /** "Oct 4, 2026". */
  date: string;
  /** The merchant's name when it is known, the bank's own text otherwise. */
  description: string;
  /** "Food and drink" — or empty when there is no category. */
  category: string;
  /** "Everyday Checking ••••1111". */
  account: string;
  /** As on a bank statement: "-$12.34" for spending, "+$500.00" for money in. */
  amount: string;
  moneyIn: boolean;
  pending: boolean;
}

/** An account to filter by. */
export interface AccountOption {
  id: string;
  /** "Maple Bank — Everyday Checking ••••1111". */
  label: string;
}

/**
 * Why there are no rows, when there are none. Four different things to tell
 * someone, each fixed in a different place.
 */
export type NoTransactions =
  | { reason: "no-banks" }
  | { reason: "nothing-synced" }
  /** The from date is after the to date. */
  | { reason: "invalid-range" }
  /** Nothing matches. `hint` says so when older or other transactions exist outside the filters. */
  | { reason: "no-match"; hint: string };

export type TransactionsView =
  | {
      state: "ready";
      rows: TransactionRowView[];
      /** How many match in all; `rows` holds the newest of them. */
      total: number;
      accounts: AccountOption[];
      /** Set exactly when `rows` is empty. */
      empty?: NoTransactions;
    }
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
  /** What unlinking a bank would delete. Takes the bank's id; changes nothing. */
  "accounts.unlinkPreview": { args: [bankId: string]; result: UnlinkPreview };
  /**
   * Unlink a bank. With `removeAtPlaid`, its connection at Plaid is ended
   * first, and if that fails nothing is deleted. Without it, only the data on
   * this computer goes and Plaid is not contacted.
   */
  "accounts.unlink": { args: [bankId: string, removeAtPlaid: boolean]; result: UnlinkResult };

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

  /**
   * For a bank whose login has expired: opens the link page in the browser in
   * its reconnect mode for that bank. Takes the bank's id and nothing else;
   * the app checks it is a bank it knows before opening anything.
   */
  "link.reconnectInBrowser": { args: [bankId: string]; result: void };

  /**
   * Start a sync of every linked bank and answer AT ONCE, with the sync as it
   * now is — running. It is not waited for: it finishes in the background and
   * `sync.changed` says when. With one already running this starts nothing.
   */
  "sync.start": { args: []; result: SyncView };
  "sync.state": { args: []; result: SyncView };

  /** The newest transactions matching a query, and how many match in all. Read-only. */
  "transactions.find": { args: [query: TransactionsQuery]; result: TransactionsView };
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
  /** A sync started or finished — whoever or whatever started it. */
  "sync.changed": [sync: SyncView];
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

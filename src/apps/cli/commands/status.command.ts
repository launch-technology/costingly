/**
 * `costingly status` — the health of everything costingly owns.
 *
 *   costingly status          human-readable, three sections
 *   costingly status --json   the same facts, machine-readable
 *
 * One view of three artifacts: the profile directory, the local database, and
 * Plaid with the banks linked through it. Each self-reports and each degrades
 * on its own — an unreachable Plaid still leaves two full sections.
 *
 * NEVER FAILS, NEVER WRITES.
 *
 * Not failing, because the broken case is the one people run this for. A status
 * command that throws when the database is down has inverted its own purpose.
 *
 * Not writing, because this is also how someone confirms an uninstall. Every
 * fact is read through paths that provision nothing — see status.service.ts. It
 * replaced `costingly doctor`, which reported the same machinery and quietly
 * recreated a profile that had just been deleted while doing it.
 *
 * It also never decrypts an access token. The bank list is metadata, and the
 * Plaid check asks about the API rather than about any one login.
 */

import type { Command } from "commander";

import {
  blockersIn,
  costinglyStatus,
  type Blocker,
  type CostinglyStatus,
  type PlaidStatus,
  type ProfileStatus,
} from "../../../domain/services/status.service.js";
import type { DatabaseHealth } from "../../../domain/services/database/database-health.service.js";
import type { ItemAccountListing } from "../../../domain/data/repositories/items.repository.js";
import { ago, money, truncate } from "../ui/format.js";

const OK = "✓";
const NO = "✗";
const WARN = "⚠";

/** Whether `stat().mode` means anything here. It does not on Windows. */
const POSIX_MODES = process.platform !== "win32";

/** Widest institution name before it is cut. Longer ones collide with the next column. */
const NAME_WIDTH = 24;

/** Section bodies are indented under a left-hand label of this width. */
const LABEL = 12;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(LABEL)}${value}`);
}

/** A continuation line under the previous label. */
function detail(value: string): void {
  console.log(`  ${" ".repeat(LABEL)}${value}`);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function renderProfile(profile: ProfileStatus): void {
  line(
    "Profile",
    profile.exists
      ? `${profile.path}   ${OK}${profile.createdAt ? `  created ${profile.createdAt}` : ""}`
      : `${profile.path}   not created yet`,
  );
  detail(
    profile.chosenBy === "platform default"
      ? "platform default"
      : `chosen by ${profile.chosenBy}`,
  );

  if (!profile.exists) {
    detail("nothing is installed — run `costingly init` to create it");
    return;
  }

  // The mode matters and is not a style preference: anything looser than 0600
  // means another account on this machine can read the encryption key.
  //
  // Windows has no POSIX modes — `stat` reports 0666 there no matter what the
  // ACL actually allows — so checking would warn on every Windows install about
  // a number that means nothing. Silence is the honest output; the real
  // protection there is the ACL, which this cannot see.
  const mode = POSIX_MODES ? profile.config.mode : null;
  const modeNote =
    mode === null ? "" : mode === 0o600 ? ` ${OK} 0600` : ` ${WARN} ${mode.toString(8)} — expected 0600`;

  detail(
    `config.json ${profile.config.exists ? `present${modeNote}` : `missing ${NO}`}` +
      `   ·   cluster ${profile.clusterExists ? "present" : "not created yet"}`,
  );

  // Only the gaps. Listing every value that IS set turns the common case into a
  // wall of text saying nothing is wrong.
  const missing = profile.values.filter((value) => value.source === "missing");
  if (missing.length > 0) {
    detail(`missing settings ${NO}  ${missing.map((value) => value.key).join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function renderDatabase(health: DatabaseHealth): void {
  const { cluster, connection } = health;

  const headline = connection.ok
    ? `running   ${OK}   ${cluster.listenAddress}`
    : cluster.state === "uninitialised"
      ? "no database yet"
      : `${cluster.state}   ${NO}`;

  line("Database", headline);

  if (connection.ok) {
    if (cluster.startedAt !== null) {
      detail(`up ${formatDuration(cluster.uptimeSeconds ?? 0)}, since ${cluster.startedAt}`);
    }
    detail(
      health.migrationsApplied === null
        ? `schema could not be read ${WARN}`
        : `schema ${health.migrationsApplied.length} migration(s) applied`,
    );
    return;
  }

  // The failure is the report. A stopped server is a normal state and gets an
  // instruction rather than an error.
  if (cluster.state === "stopped") {
    detail("the server is not running — any command that needs it will start it");
  }
  if (cluster.error !== undefined) detail(`pg_ctl: ${cluster.error}`);
  if (connection.error !== undefined && cluster.state !== "uninitialised") {
    detail(connection.error);
  }
}

// ---------------------------------------------------------------------------
// Plaid and the banks
// ---------------------------------------------------------------------------

/**
 * Flag the states that need the user to do something.
 *
 * Seeded banks are checked first and always return early. They have no cursor,
 * so every other branch here would tell the user to run a sync that will never
 * touch them — the one instruction guaranteed to be wrong.
 */
function bankNote(status: string, neverSynced: boolean, source: string): string {
  if (source === "seed") return "   ·  sample data, never synced";
  if (status === "login_required") return `   ${WARN}  NEEDS RE-LINK — run \`costingly link\``;
  if (status !== "active") return `   ${WARN}  status: ${status}`;
  if (neverSynced) return "   ·  never synced — run `costingly sync`";
  return "";
}

function renderPlaid(plaid: PlaidStatus, banks: ItemAccountListing[] | null, banksError?: string): void {
  const headline = plaid.reachable
    ? `reachable   ${OK}   ${plaid.environment}`
    : plaid.configured
      ? `unreachable   ${NO}   ${plaid.environment}`
      : `not configured   ${NO}`;

  line("Plaid", headline);
  if (!plaid.reachable && plaid.error !== undefined) detail(plaid.error);

  if (banks === null) {
    detail(
      banksError === undefined
        ? "banks unknown — the database could not be read"
        : `banks unknown — ${banksError}`,
    );
    return;
  }

  if (banks.length === 0) {
    detail("no banks linked — run `costingly link` to connect one");
    return;
  }

  // The join comes back flat, one row per account. Group it back per bank.
  const byItem = new Map<string, ItemAccountListing[]>();
  for (const row of banks) {
    const existing = byItem.get(row.item_id);
    if (existing) existing.push(row);
    else byItem.set(row.item_id, [row]);
  }

  console.log("");
  for (const rows of byItem.values()) {
    const head = rows[0]!;
    const name = truncate(head.institution_name ?? "(unknown institution)", NAME_WIDTH);
    detail(
      `${name.padEnd(NAME_WIDTH + 2)}` +
        `${`synced ${ago(head.last_synced_at)}`.padEnd(18)}` +
        bankNote(head.status, head.never_synced, head.source),
    );

    for (const row of rows) {
      if (row.account_id === null) {
        detail("  (no accounts stored — run `costingly sync`)");
        continue;
      }
      const label = `${row.account_name ?? "(unnamed)"} ••${row.mask ?? "????"}`;
      const count = Number(row.txn_count);
      detail(
        `  ${label.padEnd(30)}${money(row.current_balance, row.currency).padStart(14)}` +
          `${String(count).padStart(8)} txns`,
      );
    }
  }

  const accounts = banks.filter((row) => row.account_id !== null).length;
  const transactions = banks.reduce((sum, row) => sum + Number(row.txn_count), 0);
  console.log("");
  detail(`${byItem.size} bank(s), ${accounts} account(s), ${transactions} transaction(s)`);
}

// ---------------------------------------------------------------------------

interface StatusOptions {
  json?: boolean;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Health of the profile, the database, and Plaid")
    .helpGroup("Looking at your data:")
    .option("--json", "emit JSON instead of a human-readable summary")
    .addHelpText(
      "after",
      `
Reports on three things: the profile directory, the local database, and Plaid
with the banks linked through it. Each is reported independently, so one being
broken never hides the other two.

Has no side effects — it starts nothing, creates nothing and decrypts nothing,
so it is also how you confirm an uninstall left nothing behind.

  costingly status --json | jq '.database.connection.ok'`,
    )
    .action(async (options: StatusOptions) => {
      await runStatus(options);
    });
}

/**
 * What to do about each kind of blocker, at a terminal.
 *
 * The advice lives HERE, not in the service. `blockersIn()` reports facts, and
 * the fix differs entirely by who is reading: a missing Plaid key means running
 * `costingly init` at a terminal and opening extension settings in the bundle.
 */
const CLI_FIX: Record<Blocker["what"], string> = {
  datastore: "run `costingly init` to create it",
  server: "any command that needs the database will start it",
  schema: "run `costingly migrate`",
  "encryption-key": "run `costingly init`",
  "plaid-credentials": "run `costingly init` to enter your Plaid keys",
};

function renderBlockers(blockers: Blocker[]): void {
  if (blockers.length === 0) return;

  console.log("");
  line("Blocking", blockers.length === 1 ? "1 thing" : `${blockers.length} things`);
  for (const blocker of blockers) {
    detail(`${NO} ${blocker.detail}`);
    detail(`   ${CLI_FIX[blocker.what]}`);
  }
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const status: CostinglyStatus = await costinglyStatus();

  if (options.json) {
    // Blockers are derived rather than gathered, so they are included: a script
    // asking "is this usable" should not have to reimplement the rules.
    console.log(JSON.stringify({ ...status, blockers: blockersIn(status) }, null, 2));
    return;
  }

  console.log("");
  line("costingly", status.version);
  console.log("");
  renderProfile(status.profile);
  console.log("");
  renderDatabase(status.database);
  console.log("");
  renderPlaid(status.plaid, status.banks, status.banksError);
  renderBlockers(blockersIn(status));
  console.log("");
}

/** "45s", "3h 12m", "2d 5h" — enough precision to judge, no more. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

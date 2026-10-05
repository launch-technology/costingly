/**
 * The Accounts screen: the linked banks, and the button that links another.
 *
 * Drawing only; what is shown and when it is re-read is hooks/use-accounts.ts.
 *
 * Five states, each its own thing to see:
 *
 *   loading            the first read has not come back
 *   no banks           what linking is, and the button
 *   banks              each bank and its accounts
 *   database stopped   says so, and where to start it — and no button, since
 *                      there is nowhere to save a bank
 *   failed             what went wrong and what to do
 *
 * "Link a bank" opens the user's browser. Once it has, the screen says so and
 * says to come back: the rest happens in another program, and a button that
 * appeared to do nothing would be worse than a sentence. Reconnect, on a bank
 * whose login has expired, does the same.
 *
 * Sync refreshes every bank. The screen shows that one is running and what
 * the latest did, overall and per bank — it does not run the sync, which
 * carries on if this screen goes away (hooks/use-sync.ts).
 */

import type { Problem } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { StatusDot } from "../../components/status-dot.js";
import { useAccounts, useLinkBank } from "../../hooks/use-accounts.js";
import { useSync } from "../../hooks/use-sync.js";
import { BankCard } from "./bank-card.js";

export function AccountsScreen() {
  const { accounts, reload } = useAccounts();
  const link = useLinkBank();
  // A sync changes balances and last-synced times, so its end re-reads the list.
  const sync = useSync(reload);

  const view = accounts.phase === "loaded" ? accounts.view : null;
  const canLink = view !== null && view.state === "ready";
  const canSync = view !== null && view.state === "ready" && view.canSync;
  const state = view === null ? "loading" : view.state === "ready" && view.banks.length === 0 ? "empty" : view.state;
  const syncing = sync.view.state === "running";
  const lastSync = sync.view.state === "finished" ? sync.view : null;

  const linkButton = (
    <Button data-testid="link-bank" onClick={link.open}>
      Link a bank
    </Button>
  );

  return (
    <section data-testid="accounts-screen" data-state={state} data-sync={sync.view.state}>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <div className="flex items-center gap-2">
          {canSync && (
            <Button variant="secondary" data-testid="sync" onClick={sync.start} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync"}
            </Button>
          )}
          {canLink && state !== "empty" && linkButton}
        </div>
      </header>

      {canSync && syncing && (
        <p data-testid="sync-running" className="mb-4 text-sm text-slate-600 dark:text-slate-300">
          Syncing your banks. The first sync of a bank can take a few minutes; you can leave this
          screen while it runs.
        </p>
      )}

      {canLink && lastSync !== null && (
        <div data-testid="sync-summary" data-tone={lastSync.tone} className="mb-4">
          <p className="flex items-center gap-2 text-sm">
            <StatusDot tone={lastSync.tone} />
            {lastSync.summary}
          </p>
          {lastSync.problem !== undefined && <ProblemAlert testId="sync-problem" problem={lastSync.problem} />}
        </div>
      )}

      {link.problem !== null && <ProblemAlert testId="link-problem" problem={link.problem} />}

      {canLink && link.opened && (
        <p
          data-testid="link-opened-note"
          className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          The bank login is open in your browser. When you have finished there, come back to this
          window and the bank will be listed.
        </p>
      )}

      {view === null && (
        <p data-testid="accounts-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Loading accounts…
        </p>
      )}

      {view?.state === "database-stopped" && (
        <div data-testid="accounts-database-stopped" className="text-sm">
          <p className="mb-1 text-lg">The database is not running.</p>
          <p className="text-slate-600 dark:text-slate-300">
            Your accounts are stored in it. Start it from the Status screen, then come back here.
          </p>
        </div>
      )}

      {view?.state === "failed" && (
        <>
          <ProblemAlert testId="accounts-problem" problem={view.problem} />
          <Button variant="secondary" data-testid="accounts-retry" onClick={reload}>
            Try again
          </Button>
        </>
      )}

      {view?.state === "ready" && view.banks.length === 0 && (
        <div data-testid="accounts-empty" className="max-w-lg">
          <p className="mb-2 text-lg">No bank is linked yet.</p>
          <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
            Linking a bank lets Costingly read its accounts, balances and transactions. It opens in
            your web browser, where you log in with Plaid — your bank username and password go to
            Plaid and your bank, never to Costingly.
          </p>
          <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">
            You can link as many banks as you like, one at a time.
          </p>
          {linkButton}
        </div>
      )}

      {view?.state === "ready" && view.banks.length > 0 && (
        <>
          {view.note !== "" && (
            <p data-testid="accounts-note" className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              {view.note}
            </p>
          )}
          <div className="flex flex-col gap-4">
            {view.banks.map((bank) => (
              <BankCard
                key={bank.id}
                bank={bank}
                result={lastSync?.results.find((result) => result.bankId === bank.id)}
                onReconnect={link.reconnect}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProblemAlert({ testId, problem }: { testId: string; problem: Problem }) {
  return (
    <Alert data-testid={testId} title={problem.cause}>
      <p data-testid={`${testId}-next-step`} className="mt-1">
        {problem.nextStep}
      </p>
    </Alert>
  );
}

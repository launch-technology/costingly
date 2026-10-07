/**
 * The Settings screen: the Plaid keys, starting at sign-in, and two facts.
 *
 * Drawing only; the facts and the sign-in switch are hooks/use-settings.ts,
 * and the keys form is the same hook and the same component first-run setup
 * uses. Three sections:
 *
 *   Plaid keys          the saved client ID — never the secret — and the
 *                       form to replace both, with the one warning that
 *                       matters: keys from a different Plaid account orphan
 *                       every linked bank
 *   Start at sign-in    a switch that shows what Windows has
 *   About               the version, and where the data lives
 */

import { useState } from "react";

import type { Problem } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { KeysForm } from "../../components/keys-form.js";
import { useKeysForm } from "../../hooks/use-keys-form.js";
import { useSettings } from "../../hooks/use-settings.js";

export function SettingsScreen() {
  const settings = useSettings();
  const view = settings.state.phase === "loaded" ? settings.state.view : null;

  return (
    <section data-testid="settings-screen" data-state={settings.state.phase === "loaded" ? "ready" : settings.state.phase}>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      {settings.state.phase === "loading" && (
        <p data-testid="settings-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Loading settings…
        </p>
      )}

      {settings.state.phase === "failed" && (
        <>
          <Alert data-testid="settings-problem" title={settings.state.problem.cause}>
            <p className="mt-1">{settings.state.problem.nextStep}</p>
          </Alert>
          <Button variant="secondary" data-testid="settings-retry" onClick={settings.reload}>
            Try again
          </Button>
        </>
      )}

      {view !== null && (
        <div className="flex max-w-xl flex-col gap-8">
          <PlaidKeys clientId={view.plaidClientId} problem={view.plaidProblem} onSaved={settings.reload} />
          <StartAtSignIn on={view.startAtSignIn} control={settings.startAtSignIn} />
          <About version={view.version} dataFolder={view.dataFolder} />
        </div>
      )}
    </section>
  );
}

function PlaidKeys({ clientId, problem, onSaved }: { clientId: string | null; problem?: Problem; onSaved(): void }) {
  const [saved, setSaved] = useState(false);
  const form = useKeysForm(() => {
    setSaved(true);
    onSaved();
  });

  return (
    <section data-testid="settings-keys">
      <h2 className="mb-2 text-lg font-semibold">Plaid keys</h2>

      {problem !== undefined ? (
        <Alert data-testid="settings-keys-problem" title={problem.cause}>
          <p className="mt-1">{problem.nextStep}</p>
        </Alert>
      ) : (
        <p className="mb-4 text-sm">
          Saved client ID:{" "}
          <span data-testid="settings-client-id" className="font-mono">
            {clientId ?? "none"}
          </span>
        </p>
      )}

      {saved && (
        <p
          data-testid="settings-keys-saved"
          className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
        >
          Keys saved. Nothing needs restarting.
        </p>
      )}

      <KeysForm
        // A fresh attempt is a fresh answer: "Keys saved" must not sit beside
        // a rejection that came after it.
        form={{
          ...form,
          submit: (event) => {
            setSaved(false);
            form.submit(event);
          },
        }}
        testId="settings-keys-form"
        submitLabel="Save keys"
        before={
          <p data-testid="settings-keys-warning" className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            To change your keys, enter both again. They are checked with Plaid before anything is saved.
            If the new keys belong to a different Plaid account, your linked banks will stop syncing until
            you link them again.
          </p>
        }
      />
    </section>
  );
}

function StartAtSignIn({ on, control }: { on: boolean; control: ReturnType<typeof useSettings>["startAtSignIn"] }) {
  return (
    <section data-testid="settings-start-at-sign-in">
      <h2 className="mb-2 text-lg font-semibold">Start at sign-in</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="start-at-sign-in"
          checked={on}
          disabled={control.changing}
          onChange={(event) => control.set(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Start Costingly when I sign in</span>
          <span className="block text-slate-600 dark:text-slate-300">
            It starts in the system tray with no window, and your database comes up with it.
          </span>
        </span>
      </label>

      {control.confirmed !== null && (
        <p data-testid="start-at-sign-in-confirmed" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {control.confirmed}
        </p>
      )}
      {control.problem !== null && (
        <div className="mt-2">
          <Alert data-testid="start-at-sign-in-problem" title={control.problem.cause}>
            <p className="mt-1">{control.problem.nextStep}</p>
          </Alert>
        </div>
      )}
    </section>
  );
}

function About({ version, dataFolder }: { version: string; dataFolder: string }) {
  return (
    <section data-testid="settings-about" className="text-sm">
      <h2 className="mb-2 text-lg font-semibold">About</h2>
      <p>
        Costingly <span data-testid="settings-version">{version}</span>
      </p>
      <p className="mt-1 text-slate-600 dark:text-slate-300">Your data lives in:</p>
      <p data-testid="settings-data-folder" className="break-all font-mono">
        {dataFolder}
      </p>
    </section>
  );
}

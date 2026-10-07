/**
 * The Plaid keys form's behaviour: two fields, and what Plaid said about them.
 *
 * Used by first-run setup and by Settings, through the same request: the
 * main process proves the keys with Plaid and saves them only if Plaid
 * accepts them. Drawing the form is components/keys-form.tsx.
 *
 * Two failures, handled differently because they are fixed differently. Keys
 * Plaid rejected need retyping, so the secret is cleared and the client ID is
 * kept. Plaid not answering is a network problem, so both fields are kept.
 *
 * The secret exists here while it is being typed and is handed to the main
 * process once. Nothing that comes back contains it.
 */

import { useState, type FormEvent } from "react";

import { call } from "../api/client.js";

export interface KeysFailure {
  kind: "rejected" | "unreachable";
  reason: string;
}

export interface KeysForm {
  clientId: string;
  secret: string;
  setClientId(value: string): void;
  setSecret(value: string): void;
  /** Which fields were empty at the last attempt. */
  missing: { clientId: boolean; secret: boolean };
  /** True while Plaid is being asked. */
  checking: boolean;
  failure: KeysFailure | null;
  submit(event: FormEvent): void;
}

export function useKeysForm(onAccepted: () => void): KeysForm {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [missing, setMissing] = useState({ clientId: false, secret: false });
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<KeysFailure | null>(null);

  async function attempt(): Promise<void> {
    if (checking) return;

    const nowMissing = { clientId: clientId.trim() === "", secret: secret.trim() === "" };
    setMissing(nowMissing);
    if (nowMissing.clientId || nowMissing.secret) return;

    setChecking(true);
    setFailure(null);
    try {
      const result = await call("setup.submitKeys", clientId, secret);
      if (result.outcome === "accepted") {
        setSecret("");
        onAccepted();
        return;
      }
      if (result.outcome === "rejected") setSecret("");
      setFailure({ kind: result.outcome, reason: result.reason });
    } catch (error) {
      setFailure({
        kind: "unreachable",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  }

  return {
    clientId,
    secret,
    setClientId,
    setSecret,
    missing,
    checking,
    failure,
    submit: (event) => {
      event.preventDefault();
      void attempt();
    },
  };
}

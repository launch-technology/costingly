/**
 * The welcome step: what Costingly is, and the one thing it needs first.
 *
 * For someone who has never heard of Plaid, a form asking for "Plaid keys" is
 * a dead end. This says what Plaid is and why an account is needed, and sends
 * them to Plaid for the rest — how to sign up and what it costs are Plaid's to
 * explain, and anything repeated here would go stale.
 *
 * Shown only on a machine with no keys. Someone who already has them is one
 * click from the keys step.
 */

import { Button } from "../../components/button.js";
import { openPlaidSite } from "../../hooks/use-setup.js";

export function WelcomeStep({ onContinue }: { onContinue(): void }) {
  return (
    <div data-testid="welcome-step">
      <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">
        Costingly keeps a private copy of your bank and credit-card transactions in a database on
        this computer, so you can browse them and ask questions about your spending. Nothing is
        sent anywhere else.
      </p>

      <h2 className="mb-1 text-base font-semibold">You need a Plaid account</h2>
      <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
        Costingly reads your banks through Plaid, a service that connects apps to banks. You use
        your own Plaid account, so the connection to your banks belongs to you.
      </p>
      <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">
        If you do not have one yet, create it at Plaid, then come back with the two keys it gives
        you: a client ID and a secret.{" "}
        <Button variant="link" data-testid="welcome-plaid-link" onClick={openPlaidSite}>
          Go to Plaid to get started
        </Button>
      </p>

      <Button data-testid="welcome-continue" onClick={onContinue}>
        I have my Plaid keys
      </Button>
    </div>
  );
}

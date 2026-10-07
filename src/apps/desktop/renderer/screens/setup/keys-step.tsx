/**
 * The keys step: the Plaid keys form, with setup's words around it.
 *
 * The form itself — fields, checks, failures — is components/keys-form.tsx,
 * shared with the Settings screen. What is setup's here is the explanation
 * above it, the link to Plaid, the Continue label and the Back link.
 */

import { Button } from "../../components/button.js";
import { KeysForm } from "../../components/keys-form.js";
import { useKeysForm } from "../../hooks/use-keys-form.js";
import { openPlaidKeysPage } from "../../hooks/use-setup.js";

export function KeysStep({ onAccepted, onBack }: { onAccepted(): void; onBack(): void }) {
  const form = useKeysForm(onAccepted);

  return (
    <KeysForm
      form={form}
      testId="keys-step"
      submitLabel="Continue"
      before={
        <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">
          Costingly reads your banks through Plaid, using your own Plaid keys.{" "}
          <Button variant="link" data-testid="keys-help-link" onClick={openPlaidKeysPage}>
            Where do I find these?
          </Button>
        </p>
      }
      beside={
        <Button variant="link" data-testid="keys-back" onClick={onBack} disabled={form.checking}>
          Back
        </Button>
      }
    />
  );
}

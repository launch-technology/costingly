/**
 * First-run setup: a welcome, the keys, then the database, then done.
 *
 * Which step to start on comes from what is already saved on the machine, not
 * from any progress marker of our own — so "resume where you left off" is
 * simply true, however setup was interrupted, and a machine that already has
 * one half is only asked for the other.
 *
 * The step lives in this component's state. Closing the window hides it
 * rather than destroying it, so coming back from the tray finds the same step
 * with the same fields.
 */

import { useState } from "react";

import type { SetupState } from "../../../bridge/contract.js";
import { DatabaseStep } from "./database-step.js";
import { FinishStep } from "./finish-step.js";
import { KeysStep } from "./keys-step.js";
import { WelcomeStep } from "./welcome-step.js";

type Step = "welcome" | "keys" | "database" | "finish";

export interface SetupScreenProps {
  /** What was already in place when the app opened. */
  initial: SetupState;
  onDone(): void;
}

export function SetupScreen({ initial, onDone }: SetupScreenProps) {
  // No keys means starting from the top: the welcome explains what the keys
  // step is about to ask for.
  const [step, setStep] = useState<Step>(initial.keysPresent ? "database" : "welcome");

  return (
    <div
      data-testid="setup-screen"
      data-step={step}
      className="flex h-full items-center justify-center overflow-y-auto p-8"
    >
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Set up Costingly</h1>

        {step === "welcome" && <WelcomeStep onContinue={() => setStep("keys")} />}
        {step === "keys" && (
          <KeysStep
            onBack={() => setStep("welcome")}
            // A machine that already has a database only needed the keys.
            onAccepted={() => setStep(initial.databaseCreated ? "finish" : "database")}
          />
        )}
        {step === "database" && <DatabaseStep onReady={() => setStep("finish")} />}
        {step === "finish" && <FinishStep dataFolder={initial.dataFolder} onContinue={onDone} />}
      </div>
    </div>
  );
}

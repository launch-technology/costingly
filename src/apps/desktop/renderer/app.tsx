/**
 * The window's layout: setup until the machine is set up, then a sidebar of
 * screens and the one that is selected.
 *
 * Setup takes over the whole window. There is no sidebar and no way into the
 * rest of the app until it is finished, because nothing else works without
 * keys and a database — a Status screen that says "not set up" beside a
 * sidebar full of screens that cannot load is worse than one clear path.
 *
 * HOW THE RENDERER IS LAID OUT
 *
 *   (root)        the entry page, this shell, the stylesheet. Nothing else.
 *   api/          the typed client for the main process. Only hooks use it.
 *   hooks/        behaviour: what a screen knows and can do. One file per
 *                 feature.
 *   screens/      drawing: one file per screen, `<name>.screen.tsx`. A screen
 *                 becomes a folder when it grows pieces nobody else uses.
 *   components/   looks: UI that more than one screen uses.
 *
 * Adding a screen is a hook, a screen, an entry in the sidebar and a branch
 * below.
 */

import { useState } from "react";

import { Sidebar, type ScreenId } from "./components/sidebar.js";
import { useSetupGate } from "./hooks/use-setup.js";
import { AccountsScreen } from "./screens/accounts/accounts.screen.js";
import { SetupScreen } from "./screens/setup/setup.screen.js";
import { StatusScreen } from "./screens/status/status.screen.js";
import { TransactionsScreen } from "./screens/transactions/transactions.screen.js";

export function App() {
  const { gate, finish } = useSetupGate();
  const [screen, setScreen] = useState<ScreenId>("status");

  // Blank until the answer arrives, so the Status screen never flashes up on a
  // machine that is about to be shown setup.
  if (gate.name === "loading") return <div data-testid="app-loading" className="h-full" />;

  if (gate.name === "setup") {
    // Setup ends on Accounts: with keys and a database in place, linking a
    // bank is the next thing to do, and that screen is where it is explained.
    const done = (): void => {
      setScreen("accounts");
      finish();
    };
    return <SetupScreen initial={gate.state} onDone={done} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar current={screen} onSelect={setScreen} />
      <main className="flex-1 overflow-y-auto px-8 py-6">
        {screen === "status" && <StatusScreen />}
        {screen === "accounts" && <AccountsScreen />}
        {screen === "transactions" && <TransactionsScreen />}
      </main>
    </div>
  );
}

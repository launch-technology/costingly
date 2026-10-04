/**
 * The window's layout: a sidebar of screens, and the one that is selected.
 *
 * Which screen is showing is the only state here. Later stories add a screen
 * by adding an entry to the sidebar and a branch below — nothing else moves.
 *
 * HOW THIS FOLDER IS LAID OUT
 *
 *   (root)        the entry page, this shell, the stylesheet. Nothing else.
 *   screens/      one file per screen, `<name>.screen.tsx`. A screen becomes a
 *                 folder only when it grows pieces nobody else uses.
 *   components/   UI that two or more screens share.
 *
 * `hooks/` and `lib/` appear when the first file for them does, not before.
 */

import { useState } from "react";

import { Sidebar, type ScreenId } from "./components/sidebar.js";
import { StatusScreen } from "./screens/status.screen.js";

export function App() {
  const [screen, setScreen] = useState<ScreenId>("status");

  return (
    <div className="flex h-full">
      <Sidebar current={screen} onSelect={setScreen} />
      <main className="flex-1 overflow-y-auto px-8 py-6">
        {screen === "status" && <StatusScreen />}
      </main>
    </div>
  );
}

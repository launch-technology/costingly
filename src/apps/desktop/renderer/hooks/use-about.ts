/**
 * The About screen's behaviour: read what the program says about itself.
 *
 * Read once when the screen opens. Nothing on it changes while the app runs,
 * so there is nothing to refresh or listen for.
 */

import { useEffect, useState } from "react";

import type { AboutView, Problem } from "../../bridge/contract.js";
import { call } from "../api/client.js";

export type AboutState =
  | { phase: "loading" }
  | { phase: "loaded"; view: AboutView }
  /** The call itself failed. Rare: the facts come from a file the app was started from. */
  | { phase: "failed"; problem: Problem };

export function useAbout(): AboutState {
  const [state, setState] = useState<AboutState>({ phase: "loading" });

  useEffect(() => {
    let current = true;
    call("about.read").then(
      (view) => {
        if (current) setState({ phase: "loaded", view });
      },
      (error: unknown) => {
        if (current) {
          setState({
            phase: "failed",
            problem: {
              cause: `The program's details could not be read: ${error instanceof Error ? error.message : String(error)}`,
              nextStep: "Quit Costingly from the tray and reopen it. If it keeps happening, the app log on the Logs screen says more.",
            },
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return state;
}

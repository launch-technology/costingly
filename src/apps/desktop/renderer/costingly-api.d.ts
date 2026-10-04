/**
 * What preload.cts puts on `window`. The renderer's only door to the rest of
 * the app, and the only global it is allowed to assume.
 */

import type { CostinglyApi } from "../status-view.types.js";

declare global {
  interface Window {
    costingly: CostinglyApi;
  }
}

export {};

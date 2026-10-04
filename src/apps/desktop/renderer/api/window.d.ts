/**
 * What bridge/preload.cts puts on `window`. The renderer's only door to the
 * rest of the app, and the only global it is allowed to assume. Use it through
 * client.ts rather than directly.
 */

import type { Bridge } from "../../bridge/contract.js";

declare global {
  interface Window {
    costingly: Bridge;
  }
}

export {};

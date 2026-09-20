/**
 * The port allocator, tested against a fake store.
 *
 * No database, no config file, no profile — if this suite ever needs one of
 * those, the service has stopped being infrastructure and grown a dependency it
 * should not have.
 */

import { createServer, type Server } from "node:net";

import type { PortStore } from "../src/platform/port-allocator.js";

const { PortService } = await import("../src/platform/port-allocator.js");

const out: string[] = [];
let fail = 0;

function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    out.push(`  ok    ${what}`);
  } else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

/** A store that lives in memory and counts writes. */
function fakeStore(initial: Record<string, number> = {}) {
  let state = { ...initial };
  let writes = 0;
  const store: PortStore = {
    read: async () => ({ ...state }),
    write: async (ports) => {
      writes += 1;
      state = { ...ports };
    },
  };
  return { store, get state() { return state; }, get writes() { return writes; } };
}

/** Hold a real port so the allocator has something genuine to collide with. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

// --- the default is used when nothing is recorded ---------------------------
{
  const f = fakeStore();
  const svc = new PortService({ store: f.store, defaults: { link: 15100 } });
  const port = await svc.allocate("link");
  eq(port, 15100, "an unrecorded service starts at its default");
  eq(f.state["link"], 15100, "and the result is recorded for next time");
}

// --- a recorded port is preferred over the default --------------------------
{
  const f = fakeStore({ link: 15130 });
  const svc = new PortService({ store: f.store, defaults: { link: 15100 } });
  eq(await svc.allocate("link"), 15130, "a recorded port wins over the default");
  eq(f.writes, 0, "and nothing is rewritten when the port did not change");
}

// --- THE POINT OF THE WHOLE SERVICE: step over a port in use ----------------
{
  const taken = await occupy(15160);
  try {
    const f = fakeStore({ link: 15160 });
    const svc = new PortService({ store: f.store, defaults: { link: 15160 } });
    const port = await svc.allocate("link");
    eq(port, 15161, "A PORT IN USE IS STEPPED OVER, sequentially");
    eq(f.state["link"], 15161, "and the new port replaces the old one in the store");
  } finally {
    await close(taken);
  }
}

// --- several consecutive ports taken ----------------------------------------
{
  const a = await occupy(15190);
  const b = await occupy(15191);
  try {
    const f = fakeStore();
    const svc = new PortService({ store: f.store, defaults: { link: 15190 } });
    eq(await svc.allocate("link"), 15192, "it keeps walking upward past a run of taken ports");
  } finally {
    await close(a);
    await close(b);
  }
}

// --- giving up is bounded and says what it tried ----------------------------
{
  const a = await occupy(15220);
  try {
    const f = fakeStore();
    const svc = new PortService({ store: f.store, defaults: { link: 15220 }, maxAttempts: 1 });
    let message = "";
    try {
      await svc.allocate("link");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    ok(message.includes("Could not find a free port"), "it gives up rather than looping forever");
    ok(message.includes("15220"), "and names the range it tried");
  } finally {
    await close(a);
  }
}

// --- an unknown service is a programming error, not a silent default --------
{
  const f = fakeStore();
  const svc = new PortService({ store: f.store, defaults: { link: 15100 } });
  let message = "";
  try {
    await svc.allocate("database");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  ok(message.includes("No default port"), "an unknown service name throws");
  ok(message.includes("link"), "and lists the services it does know");
}

// --- services are independent ------------------------------------------------
{
  const f = fakeStore();
  const svc = new PortService({ store: f.store, defaults: { link: 15250, database: 15280 } });
  await svc.allocate("link");
  await svc.allocate("database");
  eq(f.state, { link: 15250, database: 15280 }, "each service keeps its own port");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);

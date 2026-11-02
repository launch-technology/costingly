/**
 * The app's local web server — its access rules, with nothing of the app
 * behind them.
 *
 *   1. An open route answers anyone on this machine; a token route answers
 *      the right token and nobody else
 *   2. Refuse by default: an unlisted path is 404 whatever is presented
 *   3. This machine only: a request naming another host is refused, and a
 *      token route refuses a request that came from a web page
 *   4. The body: too large is refused, and so is one that is not JSON
 *   5. Every refusal is reported with its reason and path — and NEVER with
 *      the token that was presented
 *   6. A port already in use makes start reject; stop frees the port
 *
 * Plain node, every platform. Requests are made with node:http rather than
 * fetch, because fetch will not let a test set the Host header, and that is
 * one of the things under test.
 */

import { request as httpRequest } from "node:http";
import { createServer } from "node:net";

import { LocalHttpServer, type Refusal } from "../src/apps/desktop/main/shell/local-http-server.js";

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/**
 * One raw request to the server, with exactly the headers given, on a fresh
 * connection each time — so "nothing is listening" is a refused connection,
 * not a kept-alive socket being reset.
 */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.once("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const TOKEN = "a-token-nobody-would-guess-0123456789abcdef";
const WRONG = "a-token-nobody-would-guess-0123456789abcdeX";
const refused: Refusal[] = [];
const json = { "content-type": "application/json" };
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const server = new LocalHttpServer({
  routes: [
    { path: "/open", access: "open", handler: (_req, res) => void res.type("text").send("open") },
    { path: "/secret", access: "token", handler: (req, res) => void res.json({ got: (req.body as unknown) ?? null }) },
  ],
  onRefused: (refusal) => void refused.push(refusal),
  maxBodyBytes: 2_000,
});
const port = await freePort();
await server.start(port, TOKEN);

// ---------------------------------------------------------------------------
// 1. Access
// ---------------------------------------------------------------------------
{
  const open = await send(port, "/open");
  eq([open.status, open.text], [200, "open"], "an open route answers with no token");

  const right = await send(port, "/secret", { method: "POST", headers: { ...bearer(TOKEN), ...json }, body: '{"hello":1}' });
  eq(right.status, 200, "A TOKEN ROUTE ANSWERS THE RIGHT TOKEN");
  eq(JSON.parse(right.text), { got: { hello: 1 } }, "and its handler got the parsed body");

  const none = await send(port, "/secret", { method: "POST", headers: json, body: "{}" });
  eq(none.status, 401, "no token: 401");
  eq(none.headers["www-authenticate"], "Bearer", "saying a bearer token is what it wants");

  const wrong = await send(port, "/secret", { method: "POST", headers: { ...bearer(WRONG), ...json }, body: "{}" });
  eq(wrong.status, 401, "A WRONG TOKEN: 401, the same as none");

  const short = await send(port, "/secret", { headers: bearer("short") });
  eq(short.status, 401, "a token of the wrong length: 401 too");

  const lowercase = await send(port, "/secret", { headers: { authorization: `bearer ${TOKEN}` } });
  eq(lowercase.status, 200, "the scheme is matched without regard to case");
}

// ---------------------------------------------------------------------------
// 2. Refuse by default
// ---------------------------------------------------------------------------
{
  const unlisted = await send(port, "/anything", { headers: bearer(TOKEN) });
  eq(unlisted.status, 404, "AN UNLISTED PATH IS 404, even with the right token");
  const root = await send(port, "/");
  eq(root.status, 404, "and so is the root");
}

// ---------------------------------------------------------------------------
// 3. This machine only
// ---------------------------------------------------------------------------
{
  const foreign = await send(port, "/open", { headers: { host: "costingly.example:80" } });
  eq(foreign.status, 403, "A REQUEST NAMING ANOTHER HOST IS REFUSED, open route or not");

  const localhost = await send(port, "/open", { headers: { host: `localhost:${port}` } });
  eq(localhost.status, 200, "localhost is this machine too");

  const paged = await send(port, "/secret", { headers: { ...bearer(TOKEN), origin: "http://127.0.0.1:4000" } });
  eq(paged.status, 403, "A TOKEN ROUTE REFUSES A REQUEST FROM A WEB PAGE, right token or not");

  const openPaged = await send(port, "/open", { headers: { origin: "http://127.0.0.1:4000" } });
  eq(openPaged.status, 200, "an open route may be asked for by a page");
}

// ---------------------------------------------------------------------------
// 4. The body
// ---------------------------------------------------------------------------
{
  const big = await send(port, "/secret", {
    method: "POST",
    headers: { ...bearer(TOKEN), ...json },
    body: JSON.stringify({ filler: "x".repeat(3_000) }),
  });
  eq(big.status, 413, "A BODY OVER THE LIMIT IS REFUSED");

  const notJson = await send(port, "/secret", { method: "POST", headers: { ...bearer(TOKEN), ...json }, body: "{not json" });
  eq(notJson.status, 400, "a body that is not JSON is refused");
}

// ---------------------------------------------------------------------------
// 5. Refusals are reported — without the token
// ---------------------------------------------------------------------------
{
  const reasons = refused.map((r) => r.reason);
  ok(reasons.some((r) => /no token/.test(r)), "a missing token is reported as such");
  ok(reasons.some((r) => /wrong/.test(r)), "a wrong token is reported as such");
  ok(reasons.some((r) => /host/.test(r)), "a foreign host is reported");
  ok(reasons.some((r) => /web page/.test(r)), "a page's request is reported");
  ok(reasons.some((r) => /too large/.test(r)), "an oversized body is reported");
  ok(reasons.some((r) => /not JSON/.test(r)), "a non-JSON body is reported");
  ok(reasons.some((r) => /nothing at that path/.test(r)), "an unlisted path is reported");
  ok(refused.every((r) => r.path.startsWith("/")), "each with its path");
  const everything = JSON.stringify(refused);
  ok(!everything.includes(WRONG) && !everything.includes("short") && !everything.includes(TOKEN), "AND NO REPORT CONTAINS A PRESENTED TOKEN");
}

// ---------------------------------------------------------------------------
// 6. Ports
// ---------------------------------------------------------------------------
{
  const second = new LocalHttpServer({ routes: [], onRefused: () => {} });
  const outcome = await second.start(port, TOKEN).then(
    () => "started",
    (error: unknown) => (error as NodeJS.ErrnoException).code ?? "rejected",
  );
  eq(outcome, "EADDRINUSE", "A PORT ALREADY IN USE MAKES START REJECT, with the code the allocator looks for");

  await server.stop();
  const refusedAfter = await send(port, "/open").then(
    () => "answered",
    (error: unknown) => (error as NodeJS.ErrnoException).code ?? "failed",
  );
  eq(refusedAfter, "ECONNREFUSED", "after stop, nothing is listening");

  await second.start(port, TOKEN);
  eq((await send(port, "/nothing")).status, 404, "and the port is free for another server");
  await second.stop();
  await server.stop();
  ok(true, "stopping a stopped server is harmless");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);

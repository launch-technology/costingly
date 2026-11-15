/**
 * The relay: an MCP server toward Claude Desktop, a client of the app behind it.
 *
 * Claude Desktop asks this process for tools and calls them; each request is
 * forwarded to the app's endpoint and the answer handed back unchanged. The
 * relay holds no list of tools and knows no tool by name, so whatever the app
 * offers is what Claude sees.
 *
 * WHEN THE APP CANNOT BE REACHED the relay still answers, with the reason and
 * the step that fixes it (messages.presenter.ts), and keeps trying: the app is
 * looked for again on the next request, through discovery, so an app opened or
 * restarted later is found without restarting this process. One tool,
 * check_costingly, is offered whenever nothing can be relayed, so Claude always
 * has something to call and report from.
 *
 * ONE THING IT CANNOT MEND: Claude Desktop reads an extension's tools once,
 * when it starts. If the app was down then, Claude Desktop lists the one tool
 * for the whole session however many times the app is reached afterwards, and
 * the only fix is to restart Claude Desktop. The relay remembers that it
 * started without the app and says so in every answer until then.
 *
 * Versions: the app reports its version in the handshake; a different major
 * version is refused, with both versions named, rather than relayed.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { AppUnavailable, type AppConnection, type AppFailure } from "./app.client.js";
import type { Discovery, Endpoint } from "./discovery.service.js";
import {
  CHECK_TOOL_DESCRIPTION,
  NEVER_OPENED,
  NOT_RUNNING,
  NOT_RUNNING_AT_START,
  RESTART_TO_SEE_ALL,
  TOKEN_REJECTED,
  UNREADABLE,
  addressUnreachable,
  incompatible,
  introduction,
  relayFailed,
} from "./messages.presenter.js";
import { compatible } from "../../platform/version.js";

const CHECK_TOOL = "check_costingly";

/** Why the app could not be relayed to, with what the wording needs. */
type Problem =
  | { kind: "never-opened" }
  | { kind: "unreadable" }
  | { kind: "unreachable"; endpoint: Endpoint }
  | { kind: "unauthorized" }
  | { kind: "incompatible"; appVersion: string }
  | { kind: "failed"; reason: string };

type Reach = { ok: true; app: AppConnection } | { ok: false; problem: Problem };

export interface RelayDependencies {
  discover(): Promise<Discovery>;
  connect(endpoint: Endpoint): Promise<AppConnection>;
  /** This extension's own name and version. */
  identity: { name: string; version: string };
  log: { info(message: string): void; warn(message: string): void };
}

export class RelayService {
  private app: AppConnection | undefined;
  /** The handshake was answered without the app, so Claude Desktop lists one tool until it restarts. */
  private startedWithoutApp = false;
  private server: Server | undefined;

  constructor(private readonly deps: RelayDependencies) {}

  /** Answer Claude Desktop over `transport` until it hangs up. */
  async start(transport: Transport): Promise<void> {
    const first = await this.reach();
    // Decided before any wording is chosen: the not-running message differs
    // between a session that began without the app and one that lost it.
    this.startedWithoutApp = !first.ok;
    const own = { name: this.deps.identity.name, version: this.deps.identity.version };
    const info = first.ok
      ? { name: own.name, version: first.app.version() ?? own.version, instructions: first.app.instructions() ?? "" }
      : { ...own, instructions: introduction(this.wording(first.problem)) };
    if (first.ok) this.deps.log.info("started with the app reachable");
    else this.deps.log.warn(`started without the app: ${first.problem.kind}`);

    const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: {} }, instructions: info.instructions });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params.name, request.params.arguments ?? {}));
    server.onclose = () => void this.stop();
    this.server = server;
    await server.connect(transport);
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    await app?.close();
    await this.server?.close().catch(() => undefined);
  }

  // --- the two requests ------------------------------------------------------

  private async listTools(): Promise<Tool[]> {
    const outcome = await this.relay((app) => app.listTools());
    return outcome.ok ? outcome.value : this.ownTools(outcome.problem);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const outcome = await this.relay((app) => app.callTool(name, args));
    if (!outcome.ok) return this.answer(outcome.problem, name);
    if (this.startedWithoutApp && name === CHECK_TOOL) return appended(outcome.value, RESTART_TO_SEE_ALL);
    return outcome.value;
  }

  /**
   * Forward one request to the app. A connection that turns out to be dead —
   * the app quit, or restarted on another port since the last request — is
   * dropped and the app looked for once more through discovery before giving
   * up, so the first request after a restart is answered, not just the second.
   */
  private async relay<T>(work: (app: AppConnection) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; problem: Problem }> {
    const first = await this.reach();
    if (!first.ok) return first;
    try {
      return { ok: true, value: await work(first.app) };
    } catch (error) {
      const problem = this.problemOf(error);
      if (problem.kind !== "unreachable") return { ok: false, problem };
    }
    const second = await this.reach();
    if (!second.ok) return second;
    try {
      return { ok: true, value: await work(second.app) };
    } catch (error) {
      return { ok: false, problem: this.problemOf(error) };
    }
  }

  // --- reaching the app ------------------------------------------------------

  /** The current connection, or a fresh one found through discovery, or why not. */
  private async reach(): Promise<Reach> {
    if (this.app !== undefined) return { ok: true, app: this.app };

    const found = await this.deps.discover();
    if (!found.found) return { ok: false, problem: { kind: found.reason } };

    try {
      const app = await this.deps.connect(found.endpoint);
      const appVersion = app.version();
      if (!compatible(appVersion, this.deps.identity.version)) {
        await app.close();
        this.deps.log.warn(`the app is version ${appVersion ?? "?"}, this extension ${this.deps.identity.version}: not relaying`);
        return { ok: false, problem: { kind: "incompatible", appVersion: appVersion ?? "unknown" } };
      }
      this.app = app;
      this.deps.log.info(`connected to the app at ${found.endpoint.url}`);
      return { ok: true, app };
    } catch (error) {
      const failure: AppFailure = error instanceof AppUnavailable ? error.failure : { kind: "failed", reason: describe(error) };
      const problem: Problem = failure.kind === "unreachable" ? { kind: "unreachable", endpoint: found.endpoint } : failure;
      this.deps.log.warn(`could not reach the app at ${found.endpoint.url}: ${problem.kind}`);
      return { ok: false, problem };
    }
  }

  /** A failure on an established connection: drop it, so the next request discovers afresh. */
  private problemOf(error: unknown): Problem {
    const lost = this.app;
    this.app = undefined;
    void lost?.close();
    const failure: AppFailure = error instanceof AppUnavailable ? error.failure : { kind: "failed", reason: describe(error) };
    this.deps.log.warn(`lost the app: ${failure.kind}`);
    if (failure.kind === "unreachable") return { kind: "unreachable", endpoint: { url: "", token: "", addressFrom: "app" } };
    return failure;
  }

  // --- what Claude is told when nothing can be relayed ------------------------

  private ownTools(problem: Problem): Tool[] {
    return [
      {
        name: CHECK_TOOL,
        description: `${CHECK_TOOL_DESCRIPTION}\n\nRight now: ${this.wording(problem).split("\n")[0] ?? ""}`,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ];
  }

  private answer(problem: Problem, tool: string): CallToolResult {
    // check_costingly reporting that the app is unreachable is its answer, not a
    // failure of the call; any other tool could not do its job.
    return { content: [{ type: "text", text: this.wording(problem) }], isError: tool !== CHECK_TOOL };
  }

  private wording(problem: Problem): string {
    switch (problem.kind) {
      case "never-opened":
        return NEVER_OPENED;
      case "unreadable":
        return UNREADABLE;
      case "unreachable":
        if (problem.endpoint.addressFrom === "settings") return addressUnreachable(problem.endpoint.url);
        return this.startedWithoutApp ? NOT_RUNNING_AT_START : NOT_RUNNING;
      case "unauthorized":
        return TOKEN_REJECTED;
      case "incompatible":
        return incompatible(problem.appVersion, this.deps.identity.version);
      case "failed":
        return relayFailed(problem.reason);
    }
  }
}

function appended(result: CallToolResult, text: string): CallToolResult {
  return { ...result, content: [...result.content, { type: "text", text }] };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The app's endpoint, as a client of it.
 *
 * MCP's standard HTTP transport, with the token on every request and this
 * extension's name and version beside it, so the app's log can say who asked.
 * Every way a connection can fail is turned into one of three kinds the relay
 * can word: nothing answering, the token refused, or something else with the
 * reason attached. Never the token in any reason.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { Endpoint } from "./discovery.service.js";

/** The header the app reads to know this extension asked, and which version of it. */
export const CLIENT_HEADER = "X-Costingly-Client";

export type AppFailure =
  | { kind: "unreachable" }
  | { kind: "unauthorized" }
  | { kind: "failed"; reason: string };

export class AppUnavailable extends Error {
  constructor(readonly failure: AppFailure) {
    super(failure.kind === "failed" ? failure.reason : failure.kind);
    this.name = "AppUnavailable";
  }
}

export interface AppConnection {
  /** The version the app reported in the handshake. */
  version(): string | undefined;
  /** The app's own introduction to a model. */
  instructions(): string | undefined;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface Identity {
  name: string;
  version: string;
}

/**
 * Connect to the app. Rejects with AppUnavailable when it cannot, classified.
 * Calls made afterwards reject the same way when the app goes away.
 */
export async function connectToApp(endpoint: Endpoint, identity: Identity, timeoutMs: number): Promise<AppConnection> {
  const client = new Client({ name: identity.name, version: identity.version });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        [CLIENT_HEADER]: `${identity.name}/${identity.version}`,
      },
    },
  });

  try {
    await client.connect(transport);
  } catch (error) {
    throw new AppUnavailable(classify(error));
  }

  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new AppUnavailable(classify(error));
    }
  };

  return {
    version: () => client.getServerVersion()?.version,
    instructions: () => client.getInstructions(),
    listTools: () => guarded(async () => (await client.listTools(undefined, { timeout: timeoutMs })).tools),
    callTool: (name, args) =>
      guarded(async () => (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult),
    close: () => client.close().catch(() => undefined),
  };
}

/** Which of the three kinds a thrown error is. */
export function classify(error: unknown): AppFailure {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return { kind: "unauthorized" };
    return { kind: "failed", reason: `the app answered ${error.code ?? "with an error"}: ${error.message}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthorized/i.test(message)) return { kind: "unauthorized" };
  if (isConnectionFailure(error)) return { kind: "unreachable" };
  return { kind: "failed", reason: message };
}

/** fetch's "failed" wraps the socket error; the code is on the cause. */
function isConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return true;
    if (/fetch failed|ECONNREFUSED|socket hang up/i.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

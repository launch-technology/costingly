/**
 * The status screen's three checks.
 *
 * Three calls rather than one: the domain's combined report returns when its
 * slowest check does, and the slowest is Plaid — a network round trip allowed
 * eight seconds. A window should not blank its profile and database sections
 * for eight seconds because the network is slow, so each section asks for its
 * own check and fills in when its own answer arrives.
 *
 * REPORT-ONLY. Nothing here creates a profile, starts a server or applies a
 * schema; the buttons that do are the database controller's.
 */

import type { PlaidStatus, ProfileStatus } from "../../../../../domain/services/status.service.js";
import type { McpSectionView, SectionView } from "../../../bridge/contract.js";
import type { Controller, HandlersFor } from "../../shared/controller.js";
import type { DatabaseSectionReader } from "../database/database.controller.js";
import { couldNotCheck, presentPlaid, presentProfile } from "./status.presenter.js";

/** The domain's checks, as this controller needs them. */
export interface StatusChecks {
  profile(): Promise<ProfileStatus>;
  plaid(): Promise<PlaidStatus>;
}

/** Reads the MCP endpoint section as it is right now. Never throws. */
export type McpSectionReader = () => Promise<McpSectionView>;

export class StatusController implements Controller<"status"> {
  constructor(
    private readonly checks: StatusChecks,
    /** The Database section, which is more than a check — see database.controller.ts. */
    private readonly databaseSection: DatabaseSectionReader,
    /** The MCP endpoint section: the app's own server, asked rather than checked. */
    private readonly mcpSection: McpSectionReader,
  ) {}

  handlers(): HandlersFor<"status"> {
    return {
      "status.profile": () => section(async () => presentProfile(await this.checks.profile())),
      "status.database": () => this.databaseSection(),
      "status.plaid": () => section(async () => presentPlaid(await this.checks.plaid())),
      "status.mcp": async () => {
        try {
          return await this.mcpSection();
        } catch (error) {
          return { ...couldNotCheck(error), canRetry: false };
        }
      },
    };
  }
}

/**
 * The checks promise not to throw. If one does anyway, the answer is a section
 * that says so: one broken section must leave the other two readable, and a
 * rejected call would take the whole screen's refresh down with it.
 */
async function section(check: () => Promise<SectionView>): Promise<SectionView> {
  try {
    return await check();
  } catch (error) {
    return couldNotCheck(error);
  }
}

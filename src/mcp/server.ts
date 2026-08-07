import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeDatabase, renderDatabaseDoc, type DatabaseDoc } from "../db/dictionary.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";


/**
 * The Costingly MCP Server
 */
export class CostinglyMcpServer {

    private _schema?: string;
    private _server: McpServer;

    constructor(version: string) {
        this._server = new McpServer({ name: "costingly", version })
    }


    /**
     * Connections the local McpServer.
     */
    async connect(transport: Transport): Promise<void> {
        await this._server.connect(transport);
    }

    private async getSchema(): Promise<string> {
        if (!this._schema) {
            const doc: DatabaseDoc = await describeDatabase();
            this._schema = renderDatabaseDoc(doc)
        }
        return this._schema;
    }

    /**
     * Registers the tools for this mcp server.
     */
    private async registerTools(): Promise<void> {
        return this._registerDescribeDatabaseTool()
    }

    /**
     * Register, connect, and stay running until the client disconnects.
     */
    async run(transport: Transport): Promise<void> {
        await this.registerTools();

        // Installed BEFORE connecting. A client that disconnects while connect()
        // is still settling would fire onclose against a hook that does not exist
        // yet, and this method would then wait forever for an event already past.
        const closed = new Promise<void>((resolve) => {
            this._server.server.onclose = () => resolve();
        });

        await this.connect(transport);

        // Nothing past this line runs until the client closes the connection.
        await closed;
    }

    private async _registerDescribeDatabaseTool(): Promise<void> {
        this._server.registerTool(
            'describe_database',
            {
                title: "Describe Costingly Database",
                description:
                    "What you need to write a correct SQL query against costingly's financial " +
                    "data: the queryable views, and every column with its type and what it " +
                    "actually means.\n\n" +
                    "Call this before writing any SQL. Several conventions here cannot be guessed " +
                    "— positive amounts mean money OUT, and a pending row is later replaced by a " +
                    "settled row with a different id, so counting both double-counts.\n\n" +
                    "Returns structure only. It does not say which values are present, how many " +
                    "rows exist, or what dates are covered, because those change on every sync. " +
                    "Enumerate those with SQL before filtering on a literal: a filter on a " +
                    "category or account this database does not contain returns zero rows rather " +
                    "than an error, which is indistinguishable from a real answer.",
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async () => ({ content: [{ type: "text", text: await this.getSchema() }] }),
        )

    }

}

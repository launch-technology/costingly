import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeSchema, renderSchemaDoc, type SchemaDoc } from "../db/dictionary.js";
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
            const schemaDoc: SchemaDoc = await describeSchema();
            this._schema = renderSchemaDoc(schemaDoc)
        }
        return this._schema;
    }

    /**
     * Registers the tools for this mcp server.
     */
    private async registerTools(): Promise<void> {
        return this._registerDescribeSchemaTool()
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

    private async _registerDescribeSchemaTool(): Promise<void> {
        this._server.registerTool(
            'describe_schema',
            {
                title: "Describe Database Schema",
                description:
                    "Everything needed to write a correct SQL query against costingly's financial " +
                    "data: the queryable views, every column with its type and meaning, and the " +
                    "values actually present in this database — real account names, the categories " +
                    "in use, and the date range covered.\n\n" +
                    "Call this before writing any SQL. Several conventions here cannot be guessed: " +
                    "positive amounts mean money OUT, pending rows can double-count, and category " +
                    "values come from a fixed vocabulary. Filtering on an account or category that " +
                    "does not exist returns zero rows, which is indistinguishable from a real answer.",
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async () => ({ content: [{ type: "text", text: await this.getSchema() }] }),
        )

    }

}

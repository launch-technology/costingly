import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";
import { CostinglyMcpServer } from "../mcp/server.js";
import { packageVersion } from "./paths.js";


export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Runs the local mcp server")
        .action(async () => {
            const transport = new StdioServerTransport();

            // StdioServerTransport listens for 'data' and 'error' on stdin, but
            // not for EOF — so when the client hangs up, the transport never
            // notices and never fires onclose. Without this, the server waits
            // forever for a disconnect that already happened, and the process
            // lingers until pg's idle timer drains the event loop.
            process.stdin.once("end", () => void transport.close());

            await new CostinglyMcpServer(packageVersion()).run(transport);
        });
}
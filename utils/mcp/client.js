import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let mcpClient = null;

async function withStreamableHttp(baseURL) {
    mcpClient = new Client({
        name: "better-streamable-http",
        version: "1.0.0",
    });

    const transport = new StreamableHTTPClientTransport(new URL(baseURL));

    await mcpClient.connect(transport);
}

async function withSSE(baseURL) {
    mcpClient = new Client({
        name: "better-sse",
        version: "1.0.0",
    });

    const transport = new SSEClientTransport(new URL(baseURL));

    await mcpClient.connect(transport);
}

/**
 * @param {Client} client
 */
async function initialize(client) {
    const prompts = await client.listPrompts();
    const resources = await client.listResources();
    const tools = await client.listTools();

    return {
        prompts,
        resources,
        tools,
    };
}

async function connectMCP({ baseURL, logger }) {
    try {
        await withStreamableHttp(baseURL);
    } catch (error) {
        logger.warn(`Could not connect with Streamable HTTP, connecting with SSE: ${error}`);
        await withSSE(baseURL);
    }

    const { prompts, resources, tools } = await initialize(mcpClient);

    return {
        prompts,
        resources,
        tools,
    };
}

export { connectMCP };

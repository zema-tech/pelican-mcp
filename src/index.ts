import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { PelicanClient } from "./client.ts";
import { registerServerTools } from "./tools/servers.ts";
import { registerFileTools } from "./tools/files.ts";
import { registerBackupTools } from "./tools/backups.ts";
import { registerConsoleTools } from "./tools/console.ts";
import { registerAdminTools } from "./tools/admin.ts";
import { registerDatabaseTools } from "./tools/databases.ts";
import { registerPluginTools } from "./tools/plugins.ts";

const url = process.env["PELICAN_URL"];
const key = process.env["PELICAN_API_KEY"];

if (!url || !key) {
  console.error("Error: PELICAN_URL and PELICAN_API_KEY environment variables must be set.");
  process.exit(1);
}

const client = new PelicanClient(url, key);

function buildServer(): McpServer {
  const server = new McpServer({ name: "pelican-mcp", version: "1.0.0" });
  registerServerTools(server, client);
  registerFileTools(server, client);
  registerBackupTools(server, client);
  registerConsoleTools(server, client);
  registerAdminTools(server, client);
  registerDatabaseTools(server, client);
  registerPluginTools(server, client);
  return server;
}

const port = process.env["PORT"];

if (port) {
  // Modalità HTTP (Render): endpoint MCP su /mcp, protetto da token
  const token = process.env["MCP_AUTH_TOKEN"];
  if (!token) {
    console.error("Error: MCP_AUTH_TOKEN must be set in HTTP mode.");
    process.exit(1);
  }
  const sha = (v: string) => createHash("sha256").update(v).digest();
  const expectedHash = sha(token);
  const isValid = (candidate: string | null | undefined): boolean =>
    !!candidate && timingSafeEqual(sha(candidate), expectedHash);

  const httpServer = createServer(async (req, res) => {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const path = parsed.pathname;
    if (path === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    // Token accettato in 3 modi: header "Bearer <token>", header con solo "<token>", oppure ?token=<token>
    const auth = (req.headers["authorization"] ?? "").trim();
    const headerToken = auth.replace(/^Bearer\s+/i, "");
    if (!isValid(headerToken) && !isValid(parsed.searchParams.get("token"))) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.listen(Number(port), "0.0.0.0", () => {
    console.error(`Pelican MCP server running on HTTP :${port}/mcp`);
  });
} else {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("Pelican MCP server running on stdio");
}

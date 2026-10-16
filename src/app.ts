import express, { type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.js";
import { OwnerOAuthProvider, SCOPE, WRITE_SCOPE } from "./auth.js";
import { SchoolisClient } from "./schoolis/client.js";
import { createMcpServer } from "./tools.js";
import { MicrosoftClient } from "./microsoft/client.js";
import { WriteServices } from "./writes/services.js";

export function createApp(config: Config, client = new SchoolisClient(config), microsoft = new MicrosoftClient(config)) {
  const app = express();
  app.use(hostHeaderValidation([config.publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"]));
  const writes = new WriteServices(config, client, microsoft);
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  const provider = new OwnerOAuthProvider(config);
  app.use(mcpAuthRouter({
    provider, issuerUrl: config.publicUrl, resourceServerUrl: config.resourceUrl,
    scopesSupported: [SCOPE, WRITE_SCOPE], resourceName: "Personal school and Microsoft data",
  }));
  app.post("/consent",
    rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => provider.approve(req, res),
  );
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "xiaobao-mcp", version: "0.1.0" }));
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = [config.publicUrl.origin, "https://chatgpt.com", "https://chat.openai.com"];
    if (origin && !allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed." }); return;
    }
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.vary("Origin");
    }
    res.set({
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
      "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    });
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  app.use("/mcp", requireBearerAuth({
    verifier: provider, requiredScopes: [SCOPE], expectedResource: config.resourceUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
  }));
  app.post("/mcp",
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
    express.json({ limit: "8mb" }),
    async (req, res) => {
      const server = createMcpServer(client, microsoft, writes);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
  app.all("/mcp", (_req, res) => { res.set("Allow", "POST, OPTIONS").status(405).json({ error: "Use POST for stateless MCP." }); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500;
    res.status([400, 413, 415].includes(status) ? status : 500).json({ error: status === 413 ? "Request body too large." : "Request could not be completed." });
  };
  app.use(errorHandler);
  return { app, provider, client };
}

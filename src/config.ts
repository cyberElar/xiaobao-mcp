import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_URL: z.url().default("http://localhost:8787"),
  OWNER_KEY: z.string().min(32),
  SCHOOLIS_URL: z.url().default("https://tsinglanstudent.schoolis.cn"),
  SESSION_FILE: z.string().default("sessions/schoolis.json"),
  CREDENTIALS_FILE: z.string().default("secrets/schoolis.json"),
  OAUTH_FILE: z.string().default("secrets/oauth.json"),
  MICROSOFT_FILE: z.string().default("secrets/microsoft.json"),
  WRITE_STATE_FILE: z.string().default("secrets/writes.json"),
  MICROSOFT_CLIENT_ID: z.uuid().optional(),
  MICROSOFT_TENANT_ID: z.uuid().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = schema.parse(environment);
  const publicUrl = new URL(env.PUBLIC_URL);
  const schoolUrl = new URL(env.SCHOOLIS_URL);
  const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  for (const url of [publicUrl, schoolUrl]) {
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Service URLs must be HTTPS origins (HTTP is allowed only on loopback).");
    }
  }
  return {
    host: env.HOST,
    port: env.PORT,
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    ownerKey: env.OWNER_KEY,
    schoolUrl,
    sessionFile: resolve(env.SESSION_FILE),
    credentialsFile: resolve(env.CREDENTIALS_FILE),
    oauthFile: resolve(env.OAUTH_FILE),
    microsoftFile: resolve(env.MICROSOFT_FILE),
    writeStateFile: resolve(env.WRITE_STATE_FILE),
    microsoftClientId: env.MICROSOFT_CLIENT_ID,
    microsoftTenantId: env.MICROSOFT_TENANT_ID,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
    cacheTtlMs: env.CACHE_TTL_SECONDS * 1000,
    trustProxyHops: env.TRUST_PROXY_HOPS,
  };
}

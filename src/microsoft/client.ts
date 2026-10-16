import { createHmac, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { z } from "zod";
import type { Config } from "../config.js";
import { ServiceError } from "../errors.js";
import { readJson, writePrivateJson } from "../storage.js";
import { graphJson, type GraphRequest } from "./http.js";
import { MicrosoftOAuth, MICROSOFT_READ_SCOPES } from "./oauth.js";
import { microsoftProfileSchema, microsoftSessionSchema, profileUrl, sessionWithTokens, type MicrosoftProfile, type MicrosoftSession } from "./session.js";

const identifier = "[A-Za-z0-9_-]{1,256}";
const allowedPath = new RegExp(`^/v1\\.0/(?:me(?:/calendarView)?|education/me/classes|education/classes/${identifier}/assignments(?:/${identifier}(?:/submissions(?:/${identifier}(?:/outcomes)?)?)?)?)$`);
const pageSchema = z.object({ value: z.array(z.unknown()), "@odata.nextLink": z.string().optional() }).passthrough();
const cursorSchema = z.object({ url: z.string().max(8192), binding: z.string(), accountId: z.string(), expiresAt: z.number() });
const submissionSchema = z.object({ recipient: z.object({ userId: z.string() }) }).passthrough();
type Parameters = Record<string, string>;
type CacheEntry = { expires: number; data: unknown };
type MicrosoftConfig = Pick<Config, "microsoftFile" | "ownerKey" | "timeoutMs" | "cacheTtlMs">;

export class MicrosoftClient {
  private session: MicrosoftSession | undefined;
  private modified = -1;
  private profile: MicrosoftProfile | undefined;
  private profileExpires = 0;
  private readonly cache = new Map<string, CacheEntry>();
  private refresh: Promise<void> | undefined;
  private retryAt = 0;
  private refreshError: ServiceError | undefined;

  constructor(private readonly config: MicrosoftConfig, private readonly fetcher: typeof fetch = fetch) {}

  private invalidate() {
    this.cache.clear();
    this.profile = undefined;
    this.profileExpires = 0;
  }

  private reload() {
    let modified = -1;
    try { modified = statSync(this.config.microsoftFile).mtimeMs; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (modified !== this.modified) {
      let raw: unknown;
      try { raw = readJson<unknown>(this.config.microsoftFile); } catch {
        throw new ServiceError("MICROSOFT_SESSION_INVALID", "The private Microsoft session file cannot be read.");
      }
      const parsed = raw === undefined ? undefined : microsoftSessionSchema.safeParse(raw);
      if (parsed && !parsed.success) throw new ServiceError("MICROSOFT_SESSION_INVALID", "The private Microsoft session file is invalid.");
      this.session = parsed?.data;
      this.modified = modified;
      this.invalidate();
      this.retryAt = 0;
      this.refreshError = undefined;
    }
    if (!this.session) throw new ServiceError("MICROSOFT_NOT_CONNECTED", "Bind Microsoft first with npm run microsoft:login.");
    return this.session;
  }

  private async renew(rejectedToken?: string) {
    const previous = this.reload();
    if (rejectedToken && previous.accessToken !== rejectedToken && previous.expiresAt > Date.now() + 60_000) return;
    if (this.refresh) return this.refresh;
    if (Date.now() < this.retryAt && this.refreshError) throw this.refreshError;
    if (!previous.refreshToken) throw new ServiceError("MICROSOFT_REAUTH_REQUIRED", "Microsoft has no refresh token. Run npm run microsoft:login.");
    this.refresh = (async () => {
      this.retryAt = Date.now() + 300_000;
      try {
        const oauth = new MicrosoftOAuth(previous, this.config.timeoutMs, this.fetcher);
        const writes = previous.scopes.filter(scope => ["EduAssignments.ReadWrite", "Calendars.ReadWrite", "Files.ReadWrite", "Files.ReadWrite.All"].includes(scope));
        const tokens = await oauth.refresh(previous.refreshToken!, `${MICROSOFT_READ_SCOPES} ${writes.join(" ")}`.trim());
        const profile = microsoftProfileSchema.parse(await graphJson(profileUrl(), tokens.access_token, this.config.timeoutMs, this.fetcher));
        if (profile.id !== previous.accountId) {
          throw new ServiceError("MICROSOFT_IDENTITY_MISMATCH", "The refreshed Microsoft account differs from the bound account.");
        }
        const current = this.reload();
        if (current.accessToken !== previous.accessToken || current.accountId !== previous.accountId ||
            current.clientId !== previous.clientId || current.tenantId !== previous.tenantId) {
          throw new ServiceError("MICROSOFT_SESSION_CHANGED", "The Microsoft binding changed during refresh. Retry the query.", true);
        }
        const session = sessionWithTokens(previous, profile.id, tokens, previous.refreshToken);
        writePrivateJson(this.config.microsoftFile, session);
        this.session = session;
        this.modified = statSync(this.config.microsoftFile).mtimeMs;
        this.invalidate();
        this.profile = profile;
        this.profileExpires = Date.now() + Math.min(this.config.cacheTtlMs, 60_000);
        this.retryAt = 0;
        this.refreshError = undefined;
      } catch (error) {
        this.refreshError = error instanceof ServiceError ? error : new ServiceError("MICROSOFT_AUTH_FAILED", "Microsoft refresh or identity verification failed.");
        if (this.refreshError.retryable) this.retryAt = Date.now() + 30_000;
        throw this.refreshError;
      }
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async read(url: URL, request?: GraphRequest) {
    let session = this.reload();
    if (session.expiresAt <= Date.now() + 60_000) {
      await this.renew();
      session = this.reload();
    }
    try { return await graphJson(url, session.accessToken, this.config.timeoutMs, this.fetcher, request); } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== "MICROSOFT_UNAUTHORIZED") throw error;
      await this.renew(session.accessToken);
      return graphJson(url, this.reload().accessToken, this.config.timeoutMs, this.fetcher, request);
    }
  }

  async getProfile(): Promise<MicrosoftProfile> {
    if (this.reload().expiresAt <= Date.now() + 60_000) await this.renew();
    if (this.profile && this.profileExpires > Date.now()) return structuredClone(this.profile);
    const profile = microsoftProfileSchema.parse(await this.read(profileUrl()));
    if (profile.id !== this.reload().accountId) {
      throw new ServiceError("MICROSOFT_IDENTITY_MISMATCH", "The current Microsoft account differs from the bound account.");
    }
    this.profile = profile;
    this.profileExpires = Date.now() + Math.min(this.config.cacheTtlMs, 60_000);
    return structuredClone(profile);
  }

  private endpoint(path: string, params: Parameters) {
    if (!allowedPath.test(path)) throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "Unsupported read-only Graph endpoint.");
    const url = new URL(path, "https://graph.microsoft.com");
    url.search = new URLSearchParams(params).toString();
    return url;
  }

  private async cached(url: URL) {
    const entry = this.cache.get(url.href);
    if (entry && entry.expires > Date.now()) return structuredClone(entry.data);
    const data = await this.read(url);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url.href, { expires: Date.now() + this.config.cacheTtlMs, data: structuredClone(data) });
    return data;
  }

  async query(path: string, params: Parameters = {}) {
    const url = this.endpoint(path, params);
    await this.getProfile();
    return this.cached(url);
  }

  async fresh(path: string) {
    this.cache.clear();
    return this.query(path);
  }

  async accountKey() {
    await this.getProfile();
    const session = this.reload();
    return `microsoft:${session.tenantId}:${session.accountId}`;
  }

  async writeCapabilities() {
    await this.getProfile();
    const scopes = new Set(this.reload().scopes);
    return {
      educationWrite: scopes.has("EduAssignments.ReadWrite"),
      calendarWrite: scopes.has("Calendars.ReadWrite"), fileWrite: scopes.has("Files.ReadWrite") || scopes.has("Files.ReadWrite.All"),
    };
  }

  async requireWritePermission(kind: "education" | "calendar" | "file") {
    const capabilities = await this.writeCapabilities();
    const required = { education: "EduAssignments.ReadWrite", calendar: "Calendars.ReadWrite", file: "Files.ReadWrite" }[kind];
    if (!capabilities[`${kind}Write`]) {
      throw new ServiceError("MICROSOFT_WRITE_PERMISSION_REQUIRED", `Microsoft authorization lacks ${required}. Run npm run microsoft:login -- --write.`, false, { requiredScopes: [required] });
    }
  }

  async mutate(path: string, body: unknown, method: "POST" | "PUT" = "POST", contentType = "application/json") {
    let permission: "education" | "calendar" | "file";
    if (method === "POST" && path === "/v1.0/me/events") permission = "calendar";
    else if (method === "POST" && new RegExp(`^/v1\\.0/education/classes/${identifier}/assignments/${identifier}/submissions/${identifier}/(?:submit|unsubmit|setUpResourcesFolder|resources)$`).test(path)) permission = "education";
    else if (method === "PUT" && /^\/v1\.0\/drives\/[A-Za-z0-9_!.-]{1,512}\/items\/[A-Za-z0-9_-]{1,256}:\/[^/]{1,2048}:\/content$/.test(path)) permission = "file";
    else throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "Unsupported Graph write endpoint.");
    await this.requireWritePermission(permission);
    const url = new URL(path, "https://graph.microsoft.com");
    if (url.search || url.hash) throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "Graph writes do not accept query strings or fragments.");
    try {
      return await this.read(url, { method, contentType, body: method === "PUT" ? new Uint8Array(body as Uint8Array) : JSON.stringify(body) });
    } finally {
      this.cache.clear();
    }
  }

  async ownSubmission(path: string) {
    const submission = submissionSchema.extend({ status: z.string(), resourcesFolderUrl: z.string().nullable().optional() }).parse(await this.fresh(path));
    if (submission.recipient.userId !== this.reload().accountId) throw new ServiceError("MICROSOFT_NOT_OWN_SUBMISSION", "This submission does not belong to the bound Microsoft account.");
    return submission;
  }

  private signature(payload: string) {
    return createHmac("sha256", this.config.ownerKey).update(`microsoft-page-v1:${payload}`).digest("base64url");
  }

  private nextUrl(value: string, path: string) {
    let url: URL;
    try { url = new URL(value); } catch {
      throw new ServiceError("MICROSOFT_INVALID_CURSOR", "Microsoft returned an invalid pagination address.");
    }
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || url.pathname !== path || value.length > 8192) {
      throw new ServiceError("MICROSOFT_INVALID_CURSOR", "The pagination address is outside the requested Graph endpoint.");
    }
    return url;
  }

  async page(path: string, params: Parameters = {}, cursor?: string) {
    const base = this.endpoint(path, params);
    await this.getProfile();
    const accountId = this.reload().accountId;
    let url = base;
    if (cursor) {
      try {
        if (cursor.length > 32_768) throw new Error("Cursor too long.");
        const [payload, signature, extra] = cursor.split(".");
        const expected = this.signature(payload ?? "");
        if (!payload || !signature || extra !== undefined || signature.length !== expected.length ||
            !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid signature.");
        const decoded = cursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
        if (decoded.binding !== base.href || decoded.accountId !== accountId || decoded.expiresAt <= Date.now()) throw new Error("Cursor binding changed.");
        url = this.nextUrl(decoded.url, path);
      } catch {
        throw new ServiceError("MICROSOFT_INVALID_CURSOR", "Use the returned cursor with the same account, filters and pageSize. Cursors expire after 30 minutes.");
      }
    }
    const raw = pageSchema.parse(await this.cached(url));
    const { "@odata.nextLink": next, ...data } = raw;
    let nextCursor: string | null = null;
    if (next) {
      this.nextUrl(next, path);
      const payload = Buffer.from(JSON.stringify({ url: next, binding: base.href, accountId, expiresAt: Date.now() + 1_800_000 })).toString("base64url");
      nextCursor = `${payload}.${this.signature(payload)}`;
    }
    return { data, pagination: { returned: raw.value.length, hasMore: nextCursor !== null, cursor: nextCursor, complete: false } };
  }

  async ownSubmissions(path: string, params: Parameters, cursor?: string) {
    const result = await this.page(path, params, cursor);
    const accountId = this.reload().accountId;
    const value = result.data.value.filter(item => {
      const parsed = submissionSchema.safeParse(item);
      return parsed.success && parsed.data.recipient.userId === accountId;
    });
    return { data: { value }, pagination: { ...result.pagination, returned: value.length } };
  }

  async publishedOutcomes(submissionPath: string, params: Parameters, cursor?: string) {
    const submission = submissionSchema.parse(await this.query(submissionPath));
    if (submission.recipient.userId !== this.reload().accountId) {
      throw new ServiceError("MICROSOFT_NOT_OWN_SUBMISSION", "This submission does not belong to the bound Microsoft account.");
    }
    const result = await this.page(`${submissionPath}/outcomes`, params, cursor);
    const value = result.data.value.map(item => {
      const outcome = z.record(z.string(), z.unknown()).parse(item);
      return Object.fromEntries(Object.entries(outcome).filter(([key]) => ["id", "@odata.type"].includes(key) || key.startsWith("published")));
    });
    return { data: { value }, pagination: result.pagination };
  }
}

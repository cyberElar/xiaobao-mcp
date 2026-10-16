import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isIP } from "node:net";
import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import { z } from "zod";
import { readJson, writePrivateJson } from "../storage.js";
import { ServiceError } from "../errors.js";

export const credentialsSchema = z.object({
  name: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(256),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export interface SessionData {
  version: 1;
  origin: string;
  loginName?: string;
  jar: SerializedCookieJar;
}

export class SchoolSession {
  jar = new CookieJar();
  loginName: string | undefined;
  revision = 0;
  private modified = -1;

  constructor(public readonly path: string, public readonly origin: string) {
    this.reload();
  }

  reload() {
    let modified = -1;
    try { modified = statSync(this.path).mtimeMs; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (modified === this.modified) return;
    const data = readJson<SessionData>(this.path);
    if (data && (data.version !== 1 || data.origin !== this.origin)) {
      throw new ServiceError("SESSION_INVALID", "The session belongs to a different school origin.");
    }
    this.jar = data ? CookieJar.deserializeSync(data.jar) : new CookieJar();
    this.loginName = data?.loginName;
    this.modified = modified;
    this.revision++;
  }

  save() {
    const jar = this.jar.serializeSync();
    if (!jar) throw new ServiceError("SESSION_INVALID", "The cookie store could not be serialized.");
    writePrivateJson(this.path, {
      version: 1, origin: this.origin, loginName: this.loginName, jar,
    } satisfies SessionData);
    this.modified = statSync(this.path).mtimeMs;
  }

  pin(loginName: string) {
    if (this.loginName && this.loginName !== loginName) {
      throw new ServiceError("IDENTITY_MISMATCH", "The school session identity changed. Bind the account again.");
    }
    this.loginName = loginName;
    this.save();
  }

  async importCookies(input: unknown) {
    const data = z.union([
      z.array(z.record(z.string(), z.unknown())),
      z.object({ cookies: z.array(z.record(z.string(), z.unknown())) }),
    ]).parse(input);
    const cookies = Array.isArray(data) ? data : data.cookies;
    const hostname = new URL(this.origin).hostname;
    const jar = new CookieJar();
    for (const item of cookies) {
      const domain = String(item.domain ?? hostname).replace(/^\./, "");
      if (hostname !== domain && !hostname.endsWith(`.${domain}`)) continue;
      if (typeof item.name !== "string" || typeof item.value !== "string" ||
          /[;\r\n]/.test(item.name + item.value)) {
        throw new ServiceError("SESSION_INVALID", "Invalid cookie name or value.");
      }
      const expires = Number(item.expires ?? item.expirationDate ?? -1);
      const path = String(item.path ?? "/");
      if (!path.startsWith("/") || /[;\r\n]/.test(path)) {
        throw new ServiceError("SESSION_INVALID", "Invalid cookie path.");
      }
      const parts = [`${item.name}=${item.value}`, `Path=${path}`];
      if (!isIP(domain) && item.hostOnly !== true &&
          (item.hostOnly === false || String(item.domain).startsWith(".") || domain !== hostname)) {
        parts.push(`Domain=${domain}`);
      }
      if (item.secure) parts.push("Secure");
      if (item.httpOnly) parts.push("HttpOnly");
      if (expires > 0) parts.push(`Expires=${new Date(expires * 1000).toUTCString()}`);
      await jar.setCookie(parts.join("; "), this.origin);
    }
    if (!(await jar.getCookieString(this.origin))) {
      throw new ServiceError("SESSION_INVALID", "No usable cookies were found for this school.");
    }
    this.jar = jar;
    this.loginName = undefined;
  }
}

export function passwordPayload(credentials: Credentials, now = Date.now()) {
  const md5 = (value: string) => createHash("md5").update(value).digest("hex").toUpperCase();
  const timestamp = Math.floor(now / 1000);
  const password = credentials.password;
  const groups = [/\d/.test(password), /[a-zA-Z]/.test(password), /\W/.test(password)].filter(Boolean).length;
  return {
    name: credentials.name,
    password: md5(md5(password) + timestamp),
    timestamp,
    isWeekPassword: password.length < 8 || password.length > 20 || groups <= 1 || password.includes("_"),
    LanguageType: 1,
  };
}

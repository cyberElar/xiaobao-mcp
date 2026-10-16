import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError,
  InvalidTokenError, TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { readJson, writePrivateJson } from "./storage.js";
import type { Config } from "./config.js";

export const SCOPE = "schoolis.read";
export const WRITE_SCOPE = "schoolis.write";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

interface Grant {
  clientId: string; redirectUri: string; codeChallenge: string; scopes: string[];
  resource: string; expires: number;
}
interface Token {
  hash: string; kind: "access" | "refresh"; clientId: string; scopes: string[];
  resource: string; expires: number; family: string; sessionExpires: number; used?: boolean;
}
interface AuthState {
  version: 1; keyFingerprint: string; clients: OAuthClientInformationFull[]; tokens: Token[];
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly state: AuthState;
  private readonly pending = new Map<string, Grant & { state?: string; browserToken: string }>();
  private readonly codes = new Map<string, Grant>();
  readonly clientsStore;

  constructor(private readonly config: Pick<Config, "ownerKey" | "oauthFile" | "publicUrl" | "resourceUrl">) {
    const saved = readJson<AuthState>(config.oauthFile);
    if (saved && saved.version !== 1) throw new Error("Unsupported OAuth state version.");
    this.state = saved?.keyFingerprint === hash(config.ownerKey) ? saved : {
      version: 1, keyFingerprint: hash(config.ownerKey), clients: [], tokens: [],
    };
    this.clientsStore = {
      getClient: (clientId: string) => this.state.clients.find(client => client.client_id === clientId),
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        if (!client.redirect_uris.length || client.redirect_uris.length > 10 ||
            client.redirect_uris.some(uri => !this.validRedirect(uri))) {
          throw new InvalidClientMetadataError("Redirect URIs must use HTTPS without credentials or fragments.");
        }
        if (this.state.clients.length >= 200) {
          throw new TemporarilyUnavailableError("Client registration capacity reached.");
        }
        const registered = { ...client, client_id: randomUUID(), client_id_issued_at: now() };
        this.state.clients.push(registered);
        this.save();
        return registered;
      },
    };
  }

  private validRedirect(value: string) {
    try {
      const url = new URL(value);
      const development = this.config.publicUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:";
      return (url.protocol === "https:" || development) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }

  private save() {
    this.state.tokens = this.state.tokens.filter(token => token.expires > now());
    writePrivateJson(this.config.oauthFile, this.state);
  }

  private prune() {
    for (const [key, value] of this.pending) if (value.expires <= now()) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expires <= now()) this.codes.delete(key);
  }

  private requireResource(resource?: URL, expected = this.config.resourceUrl.href) {
    if (resource && resource.href !== expected) throw new InvalidTargetError("Unknown MCP resource.");
    return expected;
  }

  private requireScopes(scopes: string[] = [SCOPE]) {
    if (!scopes.includes(SCOPE) || scopes.some(scope => ![SCOPE, WRITE_SCOPE].includes(scope))) {
      throw new InvalidScopeError("schoolis.read is required; schoolis.write is optional.");
    }
    return [...new Set(scopes)];
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.prune();
    if (this.pending.size >= 100 || this.codes.size >= 100) {
      throw new TemporarilyUnavailableError("Too many pending authorizations.");
    }
    const resource = this.requireResource(params.resource);
    const scopes = this.requireScopes(params.scopes);
    const id = opaque();
    const browserToken = opaque();
    this.pending.set(id, {
      clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge,
      scopes, resource, state: params.state, expires: now() + 300, browserToken: hash(browserToken),
    });
    const secure = this.config.publicUrl.protocol === "https:";
    res.cookie(secure ? "__Host-xiaobao-consent" : "xiaobao-consent", browserToken, {
      httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 300_000,
    });
    const callbackOrigin = new URL(params.redirectUri).origin
      .replace(/[;'"]/g, character => `%${character.charCodeAt(0).toString(16)}`);
    // Preserve form Origin and allow its redirect to the registered OAuth client.
    res.set({
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": `default-src 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>校宝 MCP 授权</title>
<body><main><h1>校宝 MCP 授权</h1>
<p>应用：${escapeHtml(client.client_name ?? client.client_id)}</p>
<p>回调：${escapeHtml(params.redirectUri)}</p>
<p>权限：查询学生信息、作业与附件、考试、课表、成绩、统计、学校功能状态和本人的升学档案，执行本地 GPA 计算与预测。绑定 Microsoft 后，还可读取该账号的 Teams 课程、作业、本人提交和已公布评分，以及 Outlook 日历。</p>
${scopes.includes(WRITE_SCOPE) ? "<p>写入权限：上传作业附件、提交或重新提交本人校宝作业、上传 Teams 附件、提交或撤回本人 Teams 作业，以及创建个人 Outlook 日历事件。</p>" : ""}
<form method="post" action="/consent"><input type="hidden" name="transaction" value="${id}">
<label>服务访问密钥 <input name="ownerKey" type="password" required autocomplete="current-password" maxlength="256"></label>
<button type="submit">授权访问</button></form></main></body></html>`);
  }

  approve(req: Request, res: Response) {
    this.prune();
    if (req.headers.origin !== this.config.publicUrl.origin) {
      res.status(403).send("Invalid consent origin."); return;
    }
    const id = typeof req.body?.transaction === "string" ? req.body.transaction : "";
    const grant = this.pending.get(id);
    const cookieName = this.config.publicUrl.protocol === "https:" ? "__Host-xiaobao-consent" : "xiaobao-consent";
    const cookie = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!grant || !cookie || !timingSafeEqual(Buffer.from(hash(cookie)), Buffer.from(grant.browserToken))) {
      res.status(400).send("Consent expired. Restart authorization."); return;
    }
    const supplied = typeof req.body?.ownerKey === "string" ? req.body.ownerKey : "";
    if (!timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(this.config.ownerKey)))) {
      res.status(403).send("Invalid owner key."); return;
    }
    this.pending.delete(id);
    const code = opaque();
    this.codes.set(hash(code), { ...grant, expires: now() + 60 });
    const redirect = new URL(grant.redirectUri);
    redirect.searchParams.set("code", code);
    if (grant.state !== undefined) redirect.searchParams.set("state", grant.state);
    res.clearCookie(cookieName, { path: "/", httpOnly: true, secure: this.config.publicUrl.protocol === "https:", sameSite: "strict" });
    res.redirect(redirect.href);
  }

  private code(clientId: string, value: string) {
    const grant = this.codes.get(hash(value));
    if (!grant || grant.clientId !== clientId || grant.expires <= now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return grant;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.code(client.client_id, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = this.code(client.client_id, code);
    if (redirectUri !== grant.redirectUri) throw new InvalidGrantError("The redirect URI must match the authorization request.");
    this.requireResource(resource, grant.resource);
    this.codes.delete(hash(code));
    return this.issue(client.client_id, grant.scopes, grant.resource, randomUUID(), now() + 30 * 86400);
  }

  private issue(clientId: string, scopes: string[], resource: string, family: string, sessionExpires: number): OAuthTokens {
    this.state.tokens = this.state.tokens.filter(token => token.expires > now());
    if (this.state.tokens.length >= 2000) throw new TemporarilyUnavailableError("Token capacity reached.");
    const access = opaque();
    const refresh = opaque();
    const expiresIn = Math.min(3600, sessionExpires - now());
    for (const [value, kind, expires] of [[access, "access", now() + expiresIn], [refresh, "refresh", sessionExpires]] as const) {
      this.state.tokens.push({ hash: hash(value), kind, clientId, scopes, resource, expires, family, sessionExpires });
    }
    this.save();
    return { access_token: access, refresh_token: refresh, expires_in: expiresIn, token_type: "Bearer", scope: scopes.join(" ") };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, value: string, scopes?: string[], resource?: URL) {
    const token = this.state.tokens.find(item => item.hash === hash(value) && item.kind === "refresh" && item.clientId === client.client_id);
    if (!token || token.expires <= now()) throw new InvalidGrantError("Invalid or expired refresh token.");
    if (token.used) {
      this.state.tokens = this.state.tokens.filter(item => item.family !== token.family);
      this.save();
      throw new InvalidGrantError("Refresh token reuse detected. Authorize again.");
    }
    this.requireResource(resource, token.resource);
    const requested = this.requireScopes(scopes ?? token.scopes);
    if (requested.some(scope => !token.scopes.includes(scope))) throw new InvalidScopeError("Refresh cannot expand scopes.");
    token.used = true;
    return this.issue(token.clientId, requested, token.resource, token.family, token.sessionExpires);
  }

  async verifyAccessToken(value: string) {
    const token = this.state.tokens.find(item => item.hash === hash(value) && item.kind === "access");
    if (!token || token.expires <= now()) throw new InvalidTokenError("Invalid or expired access token.");
    return {
      token: value, clientId: token.clientId, scopes: token.scopes, expiresAt: token.expires,
      resource: new URL(token.resource), extra: { owner: "personal" },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const token = this.state.tokens.find(item => item.hash === hash(request.token) && item.clientId === client.client_id);
    if (!token) return;
    this.state.tokens = this.state.tokens.filter(item => item.family !== token.family);
    this.save();
  }
}

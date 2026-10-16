import { z } from "zod";
import { ServiceError } from "../errors.js";
import { microsoftJson } from "./http.js";
import { applicationSchema, microsoftTokensSchema, type MicrosoftApplication } from "./session.js";

export const MICROSOFT_READ_SCOPES = "User.Read EduRoster.ReadBasic EduAssignments.Read Calendars.Read offline_access";
export const MICROSOFT_WRITE_SCOPES = `${MICROSOFT_READ_SCOPES} EduAssignments.ReadWrite Calendars.ReadWrite Files.ReadWrite`;
const deviceSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().min(1),
  verification_uri: z.url(), expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().min(1).max(60).default(5),
});
export type DeviceLogin = z.infer<typeof deviceSchema> & { expiresAt: number };
const oauthErrorSchema = z.object({ error: z.string() });

export class MicrosoftOAuth {
  private readonly authority: string;
  readonly application: MicrosoftApplication;
  constructor(application: MicrosoftApplication, private readonly timeoutMs = 15_000, private readonly fetcher: typeof fetch = fetch) {
    this.application = applicationSchema.parse(application);
    this.authority = `https://login.microsoftonline.com/${this.application.tenantId}/oauth2/v2.0/`;
  }

  private async request(endpoint: string, parameters: Record<string, string>) {
    return microsoftJson(new URL(endpoint, this.authority), {
      method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: this.application.clientId, ...parameters }).toString(),
    }, this.timeoutMs, this.fetcher);
  }

  private tokenResult(response: { status: number; data: unknown }) {
    if (response.status >= 200 && response.status < 300) return microsoftTokensSchema.parse(response.data);
    const error = oauthErrorSchema.safeParse(response.data);
    if (["invalid_grant", "interaction_required", "consent_required", "authorization_declined", "expired_token"].includes(error.data?.error ?? "")) {
      throw new ServiceError("MICROSOFT_REAUTH_REQUIRED", "Microsoft authorization must be renewed. Run npm run microsoft:login.");
    }
    if (["invalid_client", "unauthorized_client", "invalid_scope"].includes(error.data?.error ?? "")) {
      throw new ServiceError("MICROSOFT_AUTH_CONFIGURATION", "The Microsoft application, device flow or requested permissions are not available.");
    }
    throw new ServiceError("MICROSOFT_AUTH_FAILED", "Microsoft could not complete authorization.", response.status === 429 || response.status >= 500);
  }

  async startDeviceLogin(scopes = MICROSOFT_READ_SCOPES): Promise<DeviceLogin> {
    const response = await this.request("devicecode?mkt=zh-CN", { scope: scopes });
    if (response.status < 200 || response.status >= 300) this.tokenResult(response);
    const device = deviceSchema.parse(response.data);
    const verification = new URL(device.verification_uri);
    if (verification.protocol !== "https:" || !["login.microsoft.com", "microsoft.com", "www.microsoft.com"].includes(verification.hostname) ||
        verification.username || verification.password || verification.port) {
      throw new ServiceError("MICROSOFT_FORMAT_ERROR", "Microsoft returned an unsupported device verification address.");
    }
    return { ...device, interval: Math.max(device.interval, 5), expiresAt: Date.now() + device.expires_in * 1000 };
  }

  async pollDeviceLogin(device: DeviceLogin) {
    if (Date.now() >= device.expiresAt) throw new ServiceError("MICROSOFT_REAUTH_REQUIRED", "The Microsoft device code has expired. Start login again.");
    const response = await this.request("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code });
    const error = oauthErrorSchema.safeParse(response.data);
    if (error.data?.error === "authorization_pending") return { state: "pending" as const };
    if (error.data?.error === "slow_down") return { state: "slow_down" as const };
    return { state: "complete" as const, tokens: this.tokenResult(response) };
  }

  async refresh(refreshToken: string, scopes = MICROSOFT_READ_SCOPES) {
    return this.tokenResult(await this.request("token", { grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes }));
  }
}

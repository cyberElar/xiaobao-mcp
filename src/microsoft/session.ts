import { z } from "zod";
import type { Config } from "../config.js";
import { writePrivateJson } from "../storage.js";
import { ServiceError } from "../errors.js";
import { graphJson } from "./http.js";

export const applicationSchema = z.object({ clientId: z.uuid(), tenantId: z.uuid() });
export type MicrosoftApplication = z.infer<typeof applicationSchema>;
export const microsoftTokensSchema = z.object({
  access_token: z.string().min(1).max(40_000),
  refresh_token: z.string().min(1).max(40_000).optional(),
  expires_in: z.number().positive().max(7 * 86400),
  scope: z.string().min(1),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});
export type MicrosoftTokens = z.infer<typeof microsoftTokensSchema>;
export const microsoftSessionSchema = applicationSchema.extend({
  version: z.literal(1), accountId: z.string().min(1).max(256),
  accessToken: z.string().min(1).max(40_000), refreshToken: z.string().min(1).max(40_000).optional(),
  expiresAt: z.number().nonnegative(), scopes: z.array(z.string().min(1)).min(1),
});
export type MicrosoftSession = z.infer<typeof microsoftSessionSchema>;
export const microsoftProfileSchema = z.object({
  id: z.string().min(1), displayName: z.string().nullable().optional(),
  userPrincipalName: z.string().nullable().optional(), mail: z.string().nullable().optional(),
});
export type MicrosoftProfile = z.infer<typeof microsoftProfileSchema>;
export const profileUrl = () => new URL("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName");

export function sessionWithTokens(app: MicrosoftApplication, accountId: string, tokens: MicrosoftTokens, previousRefreshToken?: string): MicrosoftSession {
  return {
    version: 1, ...applicationSchema.parse(app), accountId,
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000, scopes: tokens.scope.split(/\s+/).filter(Boolean),
  };
}

export async function bindMicrosoftSession(
  config: Pick<Config, "microsoftFile" | "timeoutMs">, application: MicrosoftApplication,
  rawTokens: unknown, fetcher: typeof fetch = fetch,
  expectedAccountId?: string,
) {
  const tokens = microsoftTokensSchema.parse(rawTokens);
  const profile = microsoftProfileSchema.safeParse(await graphJson(profileUrl(), tokens.access_token, config.timeoutMs, fetcher));
  if (!profile.success) throw new ServiceError("MICROSOFT_IDENTITY_UNVERIFIED", "Microsoft did not return a valid account identity.");
  if (expectedAccountId && profile.data.id !== expectedAccountId) {
    throw new ServiceError("MICROSOFT_IDENTITY_MISMATCH", "The permission upgrade must use the already bound Microsoft account.");
  }
  const session = sessionWithTokens(application, profile.data.id, tokens);
  writePrivateJson(config.microsoftFile, session);
  return profile.data;
}

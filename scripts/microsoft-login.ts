import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { ServiceError } from "../src/errors.js";
import { readJson } from "../src/storage.js";
import { MicrosoftOAuth, MICROSOFT_WRITE_SCOPES } from "../src/microsoft/oauth.js";
import { applicationSchema, bindMicrosoftSession, microsoftSessionSchema } from "../src/microsoft/session.js";
import { fail } from "./shared.js";

const { values } = parseArgs({ options: { "client-id": { type: "string" }, "tenant-id": { type: "string" }, write: { type: "boolean" } } });
const config = loadConfig();
try {
  const previous = microsoftSessionSchema.safeParse(readJson(config.microsoftFile));
  const application = applicationSchema.safeParse({
    clientId: values["client-id"] ?? config.microsoftClientId ?? previous.data?.clientId,
    tenantId: values["tenant-id"] ?? config.microsoftTenantId ?? previous.data?.tenantId,
  });
  if (!application.success) {
    throw new ServiceError("MICROSOFT_AUTH_CONFIGURATION", "Provide --client-id and --tenant-id, or set MICROSOFT_CLIENT_ID and MICROSOFT_TENANT_ID.");
  }
  const oauth = new MicrosoftOAuth(application.data, config.timeoutMs);
  const device = await oauth.startDeviceLogin(values.write ? MICROSOFT_WRITE_SCOPES : undefined);
  console.info(`Open on your phone: ${device.verification_uri}`);
  console.info(`Device code: ${device.user_code}`);
  console.info(`Expires: ${new Date(device.expiresAt).toISOString()}. Sign in with your school Microsoft account.`);
  console.info(values.write ? "Requests education, calendar and file write permissions. Review them on Microsoft's consent page."
    : "Requests read-only education and calendar permissions. Existing application consent may include additional permissions.");
  let interval = device.interval;
  while (Date.now() < device.expiresAt) {
    await delay(interval * 1000);
    const result = await oauth.pollDeviceLogin(device);
    if (result.state === "slow_down") interval += 5;
    if (result.state === "complete") {
      await bindMicrosoftSession(config, application.data, result.tokens, undefined, values.write ? previous.data?.accountId : undefined);
      console.info("Microsoft identity verified. Tokens saved privately; automatic refresh is enabled.");
      process.exit(0);
    }
  }
  throw new ServiceError("MICROSOFT_REAUTH_REQUIRED", "The Microsoft device code expired. Run login again.");
} catch (error) { fail(error); }

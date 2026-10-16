import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { credentialsSchema } from "../src/schoolis/session.js";
import { readJson, writePrivateJson } from "../src/storage.js";
import { ask, fail, secret } from "./shared.js";

const { values } = parseArgs({ options: { remember: { type: "boolean" }, credentials: { type: "string" } } });
const config = loadConfig();
const pendingFile = resolve(dirname(config.sessionFile), `.login-${randomUUID()}.json`);
let captchaFile: string | undefined;
try {
  const credentials = credentialsSchema.parse(values.credentials ? readJson(values.credentials) : {
    name: (await ask("School login name: ")).trim(),
    password: await secret("School password (hidden): "),
  });
  const client = new SchoolisClient({ ...config, sessionFile: pendingFile });
  const image = await client.getCaptcha();
  let captcha: string | undefined;
  if (image) {
    const [, format, data] = /^data:image\/(png|jpeg|gif);base64,([\s\S]+)$/.exec(image)!;
    captchaFile = resolve(dirname(config.sessionFile), `captcha-${randomUUID()}.${format}`);
    mkdirSync(dirname(captchaFile), { recursive: true, mode: 0o700 });
    writeFileSync(captchaFile, Buffer.from(data!, "base64"), { mode: 0o600 });
    console.info(`Open the captcha image locally or retrieve it over SSH: ${captchaFile}`);
    captcha = (await ask("Captcha: ")).trim();
  }
  await client.login(credentials, captcha, true);
  const semesters = await client.query("/api/School/GetSchoolSemesters");
  if (!Array.isArray(semesters) || semesters.length === 0) throw new Error("School did not return a non-empty semester list.");
  renameSync(pendingFile, config.sessionFile);
  if (values.remember) writePrivateJson(config.credentialsFile, credentials);
  else rmSync(config.credentialsFile, { force: true });
  console.info("Identity and semester data verified. The bound session is ready.");
  console.info(values.remember ? "Credentials saved privately for automatic login when no captcha is required." : "Only the session is saved. Repeat login when it expires.");
} catch (error) { fail(error); } finally {
  rmSync(pendingFile, { force: true });
  if (captchaFile) rmSync(captchaFile, { force: true });
}

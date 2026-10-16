import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { readJson } from "../src/storage.js";
import { fail } from "./shared.js";

const { values } = parseArgs({ options: { file: { type: "string" } } });
if (!values.file) throw new Error("Usage: npm run session:import -- --file sessions/browser-cookies.json");
const config = loadConfig();
const pendingFile = resolve(dirname(config.sessionFile), `.import-${randomUUID()}.json`);
try {
  const client = new SchoolisClient({ ...config, sessionFile: pendingFile, credentialsFile: `${pendingFile}.unused` });
  await client.session.importCookies(readJson(values.file));
  client.session.save();
  await client.getProfile();
  const semesters = await client.query("/api/School/GetSchoolSemesters");
  if (!Array.isArray(semesters) || semesters.length === 0) throw new Error("School did not return a non-empty semester list.");
  renameSync(pendingFile, config.sessionFile);
  rmSync(config.credentialsFile, { force: true });
  console.info("Imported cookies; identity and semester data verified. Automatic password login is disabled.");
} catch (error) { fail(error); } finally {
  rmSync(pendingFile, { force: true });
}

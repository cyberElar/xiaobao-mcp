import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";

const { values } = parseArgs({ options: { "public-url": { type: "string" } } });
const path = ".env";
const existing = existsSync(path);
let content = readFileSync(existing ? path : ".env.example", "utf8");
if (!existing) content = content.replace("replace-with-at-least-32-random-characters", randomBytes(32).toString("base64url"));
if (values["public-url"]) {
  const url = values["public-url"];
  loadConfig({ OWNER_KEY: "a".repeat(32), PUBLIC_URL: url });
  const line = `PUBLIC_URL=${new URL(url).origin}`;
  content = /^PUBLIC_URL=.*$/m.test(content) ? content.replace(/^PUBLIC_URL=.*$/m, line) : `${content}\n${line}\n`;
}
if (!existing || values["public-url"]) {
  writeFileSync(path, content, { mode: 0o600, flag: existing ? "w" : "wx" });
  chmodSync(path, 0o600);
}
console.info(existing ? "Local configuration retained; requested PUBLIC_URL update applied." : "Created .env with a private random owner key.");
console.info("The owner key stays in .env. Next: npm run session:login");

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { loadConfig } from "../src/config.js";

export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "xiaobao-mcp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    config: loadConfig({
      OWNER_KEY: "test-owner-key-that-is-at-least-32-characters",
      SESSION_FILE: join(directory, "session.json"),
      CREDENTIALS_FILE: join(directory, "credentials.json"),
      OAUTH_FILE: join(directory, "oauth.json"),
      MICROSOFT_FILE: join(directory, "microsoft.json"),
      WRITE_STATE_FILE: join(directory, "writes.json"),
    }),
  };
}

export async function localServer(t: TestContext, handler?: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port.");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { publicError } from "../src/errors.js";

export async function ask(question: string) {
  const input = createInterface({ input: stdin, output: stdout });
  try { return await input.question(question); } finally { input.close(); }
}

export function secret(question: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("Interactive login requires a terminal. Use a private credentials file instead.");
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", handle);
      stdout.write("\n");
    };
    const handle = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") { cleanup(); reject(new Error("Login cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && value.length < 256) value += char;
      }
    };
    stdin.on("data", handle);
  });
}

export function fail(error: unknown) {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
}

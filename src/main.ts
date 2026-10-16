import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createApp(config);
const listener = app.listen(config.port, config.host, () => {
  console.info(`Xiaobao MCP listening on ${config.host}:${config.port}; resource ${config.resourceUrl.href}`);
});
listener.on("error", () => {
  console.error("The server could not bind to the configured host and port.");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

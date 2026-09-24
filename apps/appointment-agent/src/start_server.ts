// The start script selects server mode while direct tsx/index.ts keeps the CLI default.
process.env.APP_MODE = "server";
await import("./index.js");

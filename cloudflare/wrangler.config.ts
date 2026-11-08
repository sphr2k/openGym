import { defineWranglerConfig } from "wrangler/experimental-config";

// The read-only MCP Worker has no public assets; only the web app needs the
// Vite bundle and the 13k exercise-media files. This mode comes from cf --mode.
export default defineWranglerConfig(({mode}) =>
  mode === "mcp" ? {} : {assetsDirectory: "../frontend/dist"}
);

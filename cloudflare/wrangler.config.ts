import { defineWranglerConfig } from "wrangler/experimental-config";

// One Worker deploy bundles the browser application, API and read-only MCP.
export default defineWranglerConfig({ assetsDirectory: "../frontend/dist" });

import { bindings, defineConfig, exports } from "cf/config";

// Keep the original default Worker independent from the guarded staging
// target. Explicit --mode staging is required for the owner's cutover.
export default defineConfig(({ mode }) => {
  // Separate read-only MCP runtime: static bearer + direct cross-Worker Durable Object
  // bindings. The app's own Access policy remains untouched; never bypass it for /mcp.
  if (mode === "mcp") return {
    worker: {
      name: "opengym-mcp",
      compatibilityDate: "2026-11-03",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./src/mcp-worker.js",
      observability: {enabled: true},
      env: {
        ACCOUNTS: bindings.durableObject({worker: "opengym-cloudflare-staging", exportName: "AccountDO"}),
        PROFILES: bindings.durableObject({worker: "opengym-cloudflare-staging", exportName: "ProfileDO"}),
      },
    },
  };
  const staging = mode === "staging";
  const name = staging ? "opengym-cloudflare-staging" : "opengym-cloudflare";
  return {
    worker: {
      name,
      compatibilityDate: "2026-11-03",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./src/index.js",
      observability: { enabled: true },
      assets: { runWorkerFirst: staging ? true : ["/api/*"] },
      // Existing classes in both runtimes are backed by SQLite. These
      // declarations preserve class names and existing DO namespaces.
      exports: {
        AccountDO: exports.durableObject({ storage: "sqlite" }),
        ProfileDO: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        ALLOW_GUEST: bindings.text("true"),
        FIRST_USER_ADMIN: bindings.text("false"),
        MEDIA: bindings.r2({
          name: staging ? "opengym-cloudflare-staging-media" : "opengym-media",
        }),
        ACCOUNTS: bindings.durableObject({ worker: name, exportName: "AccountDO" }),
        PROFILES: bindings.durableObject({ worker: name, exportName: "ProfileDO" }),
        ASSETS: bindings.assets(),
      },
    },
  };
});

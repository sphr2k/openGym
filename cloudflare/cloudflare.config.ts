import { bindings, defineConfig, exports } from "cf/config";

// Production is the existing personal deployment. Its legacy resource names
// are durable identities, not labels: changing them would create empty storage.
// Keep `staging` as an alias for existing Workers Builds jobs until updated.
export default defineConfig(({ mode }) => {
  const production = mode === "production" || mode === "staging";
  const name = production ? "opengym-cloudflare-staging" : "opengym-cloudflare";
  return {
    worker: {
      name,
      compatibilityDate: "2026-11-03",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./src/index.js",
      observability: { enabled: true },
      assets: { runWorkerFirst: production ? true : ["/api/*"] },
      // Existing classes in both runtimes are backed by SQLite. These
      // declarations preserve class names and existing DO namespaces.
      exports: {
        AccountDO: exports.durableObject({ storage: "sqlite" }),
        ProfileDO: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        ALLOW_GUEST: bindings.text("true"),
        FIRST_USER_ADMIN: bindings.text("false"),
        ...(production ? { MCP_HOSTNAME: bindings.text("opengym-mcp.janw.eu") } : {}),
        MEDIA: bindings.r2({
          name: production ? "opengym-cloudflare-staging-media" : "opengym-media",
        }),
        ACCOUNTS: bindings.durableObject({ worker: name, exportName: "AccountDO" }),
        PROFILES: bindings.durableObject({ worker: name, exportName: "ProfileDO" }),
        ASSETS: bindings.assets(),
      },
    },
  };
});

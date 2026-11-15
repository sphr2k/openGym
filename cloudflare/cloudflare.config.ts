import { bindings, defineConfig, exports } from "cf/config";

// Production-only OpenGym Worker. The existing SQLite Durable Object
// namespaces were transferred in place from the former trial Worker on
// 2026-11-15; preserve their class names and self-bindings on every deploy.
export default defineConfig(({ mode }) => ({
  worker: {
    name: "opengym",
    // Never expose a direct workers.dev or version URL that bypasses Access.
    workersDev: false,
    previewUrls: false,
    compatibilityDate: "2026-11-03",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/index.js",
    observability: { enabled: true },
    assets: { runWorkerFirst: true },
    exports: {
      AccountDO: exports.durableObject({ storage: "sqlite" }),
      ProfileDO: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      ALLOW_GUEST: bindings.text("true"),
      FIRST_USER_ADMIN: bindings.text("false"),
      // Local cf dev uses the request origin for passkey tests; production has
      // an explicit RP and origin so a spoofed hostname cannot mint passkeys.
      ...(mode === "local" ? {} : {
        APP_ORIGIN: bindings.text("https://opengym.janwerner.de"),
        RP_ID: bindings.text("opengym.janwerner.de"),
      }),
      // Data-preserving legacy R2 name: 575 immutable media/snapshot objects.
      // Do not repoint to an empty bucket without a verified object migration.
      MEDIA: bindings.r2({ name: "opengym-cloudflare-staging-media" }),
      ACCOUNTS: bindings.durableObject({ worker: "opengym", exportName: "AccountDO" }),
      PROFILES: bindings.durableObject({ worker: "opengym", exportName: "ProfileDO" }),
      ASSETS: bindings.assets(),
    },
  },
}));

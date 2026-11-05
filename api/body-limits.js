// Shared application-level HTTP JSON body limit. Request/stream handling is
// platform-specific (Node IncomingMessage vs Workers ReadableStream), but the
// limit and error behavior must remain identical across supported backends.
export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

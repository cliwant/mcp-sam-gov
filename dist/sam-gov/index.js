/**
 * Vendored copy of @govicon/sam-gov.
 *
 * Why vendored: when `@govicon/mcp-sam-gov` is installed via
 * `npm install -g github:owner/repo`, npm cannot resolve a nested
 * github dep on Windows reliably (it tries to cd into a non-existent
 * directory during the install transaction). Inlining the source
 * eliminates the nested-github-dep issue entirely and keeps install
 * a pure copy.
 *
 * When both packages are published to npm, this file can become a
 * one-line re-export of the upstream package without any consumer
 * changes (the public API surface is identical).
 *
 * Source: https://github.com/seungdo-keum/govicon-sam-gov
 */
export { SamGovClient } from "./client.js";
//# sourceMappingURL=index.js.map
/**
 * Data loaders for the Cloudflare Worker build.
 *
 * The Node build of mcp-sam-gov uses readFileSync on a JSON file that
 * lives next to the compiled module. Cloudflare Workers do not have a
 * filesystem, so we re-import the JSON with import attributes — the
 * Workers bundler inlines the contents at build time. The shape is
 * identical to what `src/sba.ts` and `src/naics-crosswalk.ts` expect,
 * so we just monkey-patch the loader.
 */

import sbaData from "../src/data/sba-size-standards.json" with { type: "json" };
import naicsData from "../src/data/naics-revision-changes.json" with { type: "json" };

export const sbaSizeStandards = sbaData as unknown;
export const naicsRevisionChanges = naicsData as unknown;

/**
 * @cliwant/mcp-sam-gov/attachments — read the ACTUAL solicitation document.
 *
 * Why this exists
 * ----------------
 * An AI doing procurement research needs the real RFP/SOW/Q&A/wage-table TEXT,
 * not just the synopsis (`sam_fetch_description`) or metadata. A SAM notice
 * carries ATTACHMENTS (`resourceLinks` → keyless download URLs) that hold the
 * true requirements. The rest of the server exposes those URLs but cannot read
 * them; this module fetches one keyless and returns its extracted text so the
 * agent can analyze the buy.
 *
 * SAM attachments are predominantly PDF (compressed streams / CID fonts — not
 * hand-rollable), so PDF text extraction uses `unpdf` (a single self-contained
 * package that bundles pdfjs; no transitive deps). text/HTML also occur and are
 * decoded/stripped locally. DOCX and other binaries are NOT half-parsed — they
 * return `text:null` with an honest note.
 *
 * Truthfulness invariants (a reviewer WILL attack these):
 *   - A DOWN fetch (5xx / network / timeout) THROWS `upstream_unavailable`
 *     (retryable). A down service is NOT an empty attachment — never `text:""`.
 *   - A 404 THROWS `not_found` (the attachment id is gone).
 *   - A PDF that fails to parse (encrypted/corrupt) → `text:null` +
 *     `extractionError` note — NEVER a crash, NEVER a fake "".
 *   - A non-extractable format (docx/binary) → `text:null` + honest note.
 *   - SSRF: only sam.gov / api.sam.gov hosts are fetched; anything else →
 *     `invalid_input` with NO network call.
 *   - `truncated`/`pages` are honest.
 */
import { type MetaBundle } from "./meta.js";
/** The detected document family. */
export type AttachmentFormat = "pdf" | "docx" | "html" | "text" | "binary";
/** The tool's success payload (rides in a MetaBundle). */
export type AttachmentTextData = {
    url: string;
    filename: string | null;
    contentType: string | null;
    format: AttachmentFormat;
    sizeBytes: number;
    pages: number | null;
    text: string | null;
    truncated: boolean;
    extracted: boolean;
};
export type FetchAttachmentTextArgs = {
    url: string;
    maxChars?: number;
};
/**
 * Fetch a SAM attachment keyless and return its extracted TEXT.
 *
 * See the module header for the truthfulness invariants. Throws a
 * `ToolErrorCarrier` for: bad/non-SAM URL (`invalid_input`, no fetch), a 404
 * (`not_found`), or a down fetch (`upstream_unavailable`, retryable). Otherwise
 * ALWAYS returns a payload — a document we cannot extract yields `text:null` +
 * a disclosed note, never an exception and never a fabricated string.
 */
export declare function fetchAttachmentText(args: FetchAttachmentTextArgs): Promise<MetaBundle<AttachmentTextData>>;
//# sourceMappingURL=attachments.d.ts.map
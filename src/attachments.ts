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
 * decoded/stripped locally. DOCX is a ZIP whose `word/document.xml` holds the
 * body text (deflate-compressed); we parse the ZIP container by hand and inflate
 * that entry with Node's built-in `node:zlib` — NO new dependency. Other
 * binaries are NOT half-parsed — they return `text:null` with an honest note.
 *
 * Truthfulness invariants (a reviewer WILL attack these):
 *   - A DOWN fetch (5xx / network / timeout) THROWS `upstream_unavailable`
 *     (retryable). A down service is NOT an empty attachment — never `text:""`.
 *   - A 404 THROWS `not_found` (the attachment id is gone).
 *   - A PDF that fails to parse (encrypted/corrupt) → `text:null` +
 *     `extractionError` note — NEVER a crash, NEVER a fake "".
 *   - A DOCX that fails to parse (corrupt/not-a-zip/no `word/document.xml`) →
 *     `text:null` + a disclosed note — NEVER a crash, NEVER a fake "".
 *   - A non-extractable format (binary) → `text:null` + honest note.
 *   - SSRF: only sam.gov / api.sam.gov hosts are fetched; anything else →
 *     `invalid_input` with NO network call.
 *   - `truncated`/`pages` are honest.
 */

import zlib from "node:zlib";
import { extractText, getDocumentProxy } from "unpdf";
import { ToolErrorCarrier, type ToolError } from "./errors.js";
import { withMeta, type MetaBundle } from "./meta.js";

/** Default cap on returned text (chars). Large enough for a full RFP body. */
const DEFAULT_MAX_CHARS = 200_000;
/** Hard guard on the cap (mirrors the Zod max) — belt-and-suspenders. */
const MAX_MAX_CHARS = 500_000;
/**
 * Refuse to buffer/parse an attachment larger than this (SAM/S3 send
 * content-length; SAM files are well under this). Bounds memory before the whole
 * body is read into an ArrayBuffer + parsed by unpdf.
 */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/**
 * Cap on the DECOMPRESSED size of a DOCX's `word/document.xml`. The fetch size
 * guard bounds the compressed input, but deflate can expand ~1000× — a crafted
 * "zip bomb" DOCX (SAM accepts vendor uploads) could inflate to GBs and OOM. A
 * real Word body is far under this; `inflateRawSync` throws past it → caught →
 * text:null + a disclosed note.
 */
const MAX_DOCX_XML_BYTES = 100 * 1024 * 1024;

/** Browser-ish UA — SAM serves the keyless file endpoint to a normal client. */
const BROWSER_UA =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";

/** Fetch timeout for a (potentially large) attachment download. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * SSRF allow-list: an `https://` URL whose host is exactly `sam.gov` or
 * `api.sam.gov` (or a subdomain of `sam.gov`). We intentionally do NOT fetch
 * arbitrary hosts — the input is a SAM attachment download URL, nothing else.
 */
function assertSamAttachmentUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Not a valid URL: ${JSON.stringify(url)}. Expected a SAM attachment download URL (https://sam.gov/... or https://api.sam.gov/...).`,
      retryable: false,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Only https:// SAM attachment URLs are fetched (got ${parsed.protocol}//). SSRF hygiene: this tool fetches sam.gov / api.sam.gov only.`,
      retryable: false,
    });
  }
  const host = parsed.hostname.toLowerCase();
  const isSam =
    host === "sam.gov" ||
    host === "api.sam.gov" ||
    host.endsWith(".sam.gov");
  if (!isSam) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Refusing to fetch non-SAM host ${JSON.stringify(host)}. This tool only reads sam.gov / api.sam.gov attachment URLs (SSRF hygiene + scope). Pass a URL from sam_get_opportunity's attachments[].url.`,
      retryable: false,
    });
  }
  return parsed;
}

/** Parse a filename out of a `content-disposition` header, if present. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  // RFC 5987 `filename*=UTF-8''...` takes precedence when present.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain && plain[1]) return plain[1].trim();
  return null;
}

/** Lowercased file extension (no dot) from a filename, or "". */
function extOf(filename: string | null): string {
  if (!filename) return "";
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(filename);
  return m && m[1] ? m[1].toLowerCase() : "";
}

/** The detected document family. */
export type AttachmentFormat = "pdf" | "docx" | "html" | "text" | "binary";

/**
 * Detect the format from magic bytes (authoritative) + filename ext +
 * content-type (advisory). Magic bytes win because SAM serves everything as
 * `application/octet-stream`.
 */
function detectFormat(
  bytes: Uint8Array,
  contentType: string,
  ext: string,
): AttachmentFormat {
  const ct = contentType.toLowerCase();
  // %PDF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "pdf";
  }
  // PK\x03\x04 (ZIP container) → treat as docx ONLY when the ext/CT say so;
  // other zip-based Office/archive formats fall through to "binary".
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    if (ext === "docx" || ct.includes("wordprocessingml")) return "docx";
    return "binary";
  }
  // HTML: content-type says so, OR the body starts (after BOM/whitespace) with
  // '<' plus an html-ish token.
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    return "html";
  }
  const head = sniffLeadingText(bytes, 512).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "html";
  }
  // A body that opens with a tag and carries an html-ish element (but is NOT an
  // XML declaration) reads as HTML.
  if (
    !head.startsWith("<?xml") &&
    head.startsWith("<") &&
    /<(html|body|div|p|table|head)\b/.test(head)
  ) {
    return "html";
  }
  // Plain textual content-types.
  if (
    ct.includes("text/plain") ||
    ct.includes("text/csv") ||
    ct.includes("application/csv") ||
    ct.includes("text/xml") ||
    ct.includes("application/xml") ||
    ct.includes("application/json") ||
    ct.includes("text/")
  ) {
    return "text";
  }
  // Extension-based textual fallback (SAM serves octet-stream).
  if (["txt", "csv", "xml", "json", "tsv", "md", "log"].includes(ext)) {
    return "text";
  }
  // Looks like text if it decodes cleanly with no NUL/control soup.
  if (looksTextual(bytes)) return "text";
  return "binary";
}

/** Decode the first `n` bytes as UTF-8 for a cheap content sniff. */
function sniffLeadingText(bytes: Uint8Array, n: number): string {
  const slice = bytes.subarray(0, Math.min(n, bytes.length));
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(slice);
  } catch {
    return "";
  }
}

/**
 * Heuristic: does the byte buffer look like human-readable text? True when
 * there are no NUL bytes and the share of control chars (outside tab/CR/LF) is
 * tiny. Used only as a last-resort fallback when magic bytes + CT + ext are
 * all inconclusive.
 */
function looksTextual(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(1024, bytes.length));
  if (sample.length === 0) return false;
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false; // NUL ⇒ binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / sample.length < 0.05;
}

/** Decode common HTML/XML entities that survive tag-stripping. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    // &amp; last so we don't double-decode an already-decoded entity.
    .replace(/&amp;/g, "&");
}

/**
 * Strip HTML to readable text: drop <script>/<style> CONTENT entirely, remove
 * all remaining tags, decode entities, collapse whitespace. Mirrors the
 * approach used elsewhere in the server (sam-gov description, gao, ecfr).
 */
function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the body text of a DOCX (Office Open XML) file, dependency-free.
 *
 * A DOCX is a ZIP archive; the document body lives in `word/document.xml`
 * (normally deflate-compressed, ZIP method 8). We parse the ZIP container by
 * hand — locate the End-Of-Central-Directory record, walk the central
 * directory to find `word/document.xml`, read its local file header to compute
 * the compressed-data offset, slice those bytes, and inflate them with Node's
 * built-in `node:zlib` (`inflateRawSync`; method 0 = stored → bytes as-is). The
 * resulting XML is reduced to plain text: `</w:p>`/`</w:tr>` become newlines,
 * `<w:tab/>` a tab, ALL remaining tags are stripped whole (so open-tag
 * attributes like `w14:paraId="…"` never leak), entities are decoded, and
 * runs of intra-line whitespace are collapsed.
 *
 * DEFENSIVE: every offset/length read is bounds-checked. Any structural problem
 * (buffer too small, EOCD/CD/LFH signature bad, an offset or length past the
 * end of the buffer, `word/document.xml` absent, an unsupported compression
 * method, or an inflate throw) raises a normal `Error`. It never reads out of
 * bounds, never loops unbounded, and never returns garbage — the CALLER catches
 * the throw and reports `text:null` + a disclosed note.
 *
 * @throws {Error} on any malformed/unsupported input.
 */
function extractDocxText(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number): number => dv.getUint32(o, true); // little-endian
  const u16 = (o: number): number => dv.getUint16(o, true);
  const utf8 = (start: number, end: number): string =>
    new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(start, end),
    );

  const EOCD_SIG = 0x06054b50; // PK\x05\x06 End-Of-Central-Directory
  const CD_SIG = 0x02014b50; // PK\x01\x02 central-directory file header
  const LFH_SIG = 0x04034b50; // PK\x03\x04 local file header

  const n = bytes.length;
  // EOCD is 22 bytes minimum (before any trailing comment).
  if (n < 22) throw new Error("not a valid DOCX (file too small to be a ZIP)");

  // 1. Locate the End-Of-Central-Directory by scanning backward. It sits within
  //    the last 22 bytes + an optional comment (<= 0xffff), so bound the scan.
  let eocd = -1;
  const minStart = Math.max(0, n - 22 - 0xffff);
  for (let i = n - 22; i >= minStart; i--) {
    if (u32(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("not a valid DOCX (ZIP End-Of-Central-Directory not found)");
  }

  const entryCount = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  if (cdOffset >= n) {
    throw new Error("corrupt DOCX (ZIP central-directory offset past end of file)");
  }

  // 2. Walk the central directory to find `word/document.xml`.
  let p = cdOffset;
  let target: { method: number; compressedSize: number; lho: number } | null =
    null;
  for (let e = 0; e < entryCount; e++) {
    if (p + 46 > n) {
      throw new Error("corrupt DOCX (ZIP central-directory entry truncated)");
    }
    if (u32(p) !== CD_SIG) {
      throw new Error("corrupt DOCX (ZIP central-directory signature invalid)");
    }
    const method = u16(p + 10);
    const compressedSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const lho = u32(p + 42);
    const nameStart = p + 46;
    if (nameStart + nameLen > n) {
      throw new Error("corrupt DOCX (ZIP entry name past end of file)");
    }
    const name = utf8(nameStart, nameStart + nameLen);
    if (name === "word/document.xml") {
      target = { method, compressedSize, lho };
      break;
    }
    p = nameStart + nameLen + extraLen + commentLen;
  }
  if (!target) {
    throw new Error(
      "not a valid Word document (word/document.xml not found in the ZIP)",
    );
  }

  // 3. Read the local file header to compute where the entry's data begins.
  const { method, compressedSize, lho } = target;
  if (lho + 30 > n) {
    throw new Error("corrupt DOCX (ZIP local file header past end of file)");
  }
  if (u32(lho) !== LFH_SIG) {
    throw new Error("corrupt DOCX (ZIP local file header signature invalid)");
  }
  const localNameLen = u16(lho + 26);
  const localExtraLen = u16(lho + 28);
  const dataStart = lho + 30 + localNameLen + localExtraLen;
  if (dataStart + compressedSize > n) {
    throw new Error("corrupt DOCX (ZIP entry data past end of file)");
  }
  const comp = bytes.subarray(dataStart, dataStart + compressedSize);

  // 4. Decompress: method 8 = deflate (raw), method 0 = stored (as-is).
  let xmlBytes: Uint8Array;
  if (method === 8) {
    // maxOutputLength caps the inflated size → throws on a zip-bomb DOCX.
    xmlBytes = zlib.inflateRawSync(comp, { maxOutputLength: MAX_DOCX_XML_BYTES });
  } else if (method === 0) {
    xmlBytes = comp;
  } else {
    throw new Error(`unsupported DOCX ZIP compression method ${method}`);
  }
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);

  // 5. XML → text. Convert paragraph/row breaks and tabs to whitespace FIRST,
  //    then strip ALL remaining tags whole (`<w:p w14:paraId="…">` included, so
  //    no attribute text leaks), decode entities, collapse intra-line runs.
  const text = decodeEntities(
    xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

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
export async function fetchAttachmentText(
  args: FetchAttachmentTextArgs,
): Promise<MetaBundle<AttachmentTextData>> {
  const parsed = assertSamAttachmentUrl(args.url);
  const url = parsed.toString();
  const maxChars = Math.min(
    Math.max(1, args.maxChars ?? DEFAULT_MAX_CHARS),
    MAX_MAX_CHARS,
  );

  // ── Fetch keyless. A down fetch is an OUTAGE (throw), never empty text. ──
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // Network-level fault or timeout ⇒ retryable outage.
    const err: ToolError = {
      kind: "upstream_unavailable",
      message: `Network error fetching SAM attachment ${url}: ${(e as Error).message}. The service is unavailable, NOT an empty attachment — retry.`,
      retryable: true,
      retryAfterSeconds: 30,
      upstreamEndpoint: "sam:attachment",
    };
    throw new ToolErrorCarrier(err);
  }

  if (res.status === 404) {
    throw new ToolErrorCarrier({
      kind: "not_found",
      message: `SAM attachment not found (HTTP 404) at ${url}. The attachment id is gone.`,
      retryable: false,
      upstreamStatus: 404,
      upstreamEndpoint: "sam:attachment",
    });
  }
  if (!res.ok) {
    // Any other non-2xx (5xx, 429, transient 4xx) ⇒ treat as a retryable
    // outage. A DOWN attachment endpoint is NOT an empty document.
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `SAM attachment fetch returned HTTP ${res.status} at ${url} — the service is unavailable, NOT an empty attachment. Retry.`,
      retryable: true,
      retryAfterSeconds: 60,
      upstreamStatus: res.status,
      upstreamEndpoint: "sam:attachment",
    });
  }

  // Redirect safety (SSRF defense-in-depth): `fetch` followed redirects — SAM's
  // download endpoint 303-redirects to a time-signed S3 URL and the extraction
  // DEPENDS on that hop, so off-host redirects can't be forbidden outright.
  // Instead re-validate the FINAL host: allow *.sam.gov and SAM's S3 attachment
  // store, reject anything else — a redirect must never reach an internal /
  // cloud-metadata / attacker host and have its body read back as "text".
  const finalHost = (() => {
    try {
      return new URL(res.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const finalHostOk =
    finalHost === "" || // some runtimes leave res.url empty; the input host was already allow-listed
    finalHost === "sam.gov" ||
    finalHost.endsWith(".sam.gov") ||
    (finalHost.endsWith(".amazonaws.com") && finalHost.includes("s3"));
  if (!finalHostOk) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `The SAM attachment URL redirected to an unexpected host ${JSON.stringify(finalHost)}; refusing to read it back (SSRF safety). Expected sam.gov or SAM's S3 attachment store.`,
      retryable: false,
    });
  }

  // Size guard: refuse an attachment larger than the cap BEFORE buffering it
  // whole (unpdf then parses the whole buffer). SAM/S3 send content-length.
  const declaredLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_ATTACHMENT_BYTES) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `SAM attachment is ${Math.round(declaredLen / 1048576)} MB, over this tool's ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} MB limit — download it directly at ${url}.`,
      retryable: false,
      upstreamEndpoint: "sam:attachment",
    });
  }

  const contentType = res.headers.get("content-type");
  const disposition = res.headers.get("content-disposition");
  const filename = filenameFromDisposition(disposition);
  const ext = extOf(filename);

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sizeBytes = bytes.byteLength;

  const format = detectFormat(bytes, contentType ?? "", ext);

  const notes: string[] = [];
  let text: string | null = null;
  let pages: number | null = null;

  if (format === "pdf") {
    try {
      const pdf = await getDocumentProxy(bytes);
      const { totalPages, text: extracted } = await extractText(pdf, {
        mergePages: true,
      });
      pages = totalPages;
      text = extracted;
    } catch (e) {
      // Encrypted / corrupt / unsupported PDF. This is NOT an outage and NOT an
      // empty document — disclose the failure and return text:null.
      text = null;
      pages = null;
      notes.push(
        `PDF text extraction failed (extractionError): ${(e as Error).message}. The file may be encrypted, corrupt, or image-only (scanned). It was NOT read; download it at ${url}.`,
      );
    }
  } else if (format === "docx") {
    // DOCX (ZIP + word/document.xml): extract the body text dependency-free.
    // A corrupt/invalid/no-word-document DOCX is NOT an outage and NOT an empty
    // document — disclose the failure and return text:null (the B1 empty-guard
    // downstream turns a genuinely empty body into text:null + a disclosed note).
    try {
      text = extractDocxText(bytes);
      pages = null;
    } catch (e) {
      text = null;
      pages = null;
      notes.push(
        `DOCX text extraction failed: ${(e as Error).message}. The file may be corrupt or not a valid Word document — download it at ${url}.`,
      );
    }
  } else if (format === "html") {
    text = stripHtml(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } else if (format === "text") {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } else {
    // binary / other — do NOT half-parse.
    text = null;
    pages = null;
    notes.push(
      `${format} content is not extractable keyless in this tool — download it at ${url}.`,
    );
  }

  // ── Validate the extracted text is REAL content, not a masquerade. ──
  // A fetch+parse that yields EMPTY text (an image-only/scanned PDF with no text
  // layer — common for wage determinations, signed SF-1442s, drawings — or an
  // empty body) or DECODE-GARBAGE (a non-UTF-8 charset mis-decoded into NUL /
  // replacement-char soup) must NOT read as "the document's text is empty/this".
  // Report text:null + a disclosed reason instead (a scanned PDF keeps its honest
  // `pages` count — it HAS pages, just no text layer).
  if (text != null) {
    const replacementShare =
      (text.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, text.length);
    if (text.trim().length === 0) {
      notes.push(
        format === "pdf"
          ? `This PDF has NO extractable text layer — it is likely scanned/image-only (a photo of the page). It was NOT read as text; download it at ${url} (or run OCR).`
          : `The ${format} attachment decoded to empty/whitespace content — nothing to read; download it at ${url}.`,
      );
      text = null;
    } else if (text.includes("\u0000") || replacementShare > 0.1) {
      notes.push(
        `The ${format} attachment could not be decoded as readable UTF-8 text (it likely uses a different character set, or is binary mislabeled as text) — download it at ${url}.`,
      );
      text = null;
    }
  }

  // ── Truncate honestly. ──
  let truncated = false;
  if (text != null && text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
    notes.push(
      `Text truncated to maxChars=${maxChars} characters (the document is longer). Raise maxChars or fetch the file directly for the full text.`,
    );
  }

  const extracted = text != null;
  if (extracted) {
    notes.push(`Detected format: ${format}.`);
  }

  const data: AttachmentTextData = {
    url,
    filename,
    contentType,
    format,
    sizeBytes,
    pages,
    text,
    truncated,
    extracted,
  };

  return withMeta(data, {
    source: "sam.gov (keyless attachment)",
    keylessMode: true,
    // We fully delivered the document iff we extracted text AND did not truncate.
    complete: extracted && !truncated ? undefined : false,
    truncated,
    returned: extracted ? 1 : 0,
    totalAvailable: null,
    fieldsUnavailable: extracted ? [] : ["text"],
    notes,
  });
}

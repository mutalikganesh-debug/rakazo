import { DOCX_MIME_TYPE } from "@rakazo/contracts";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/**
 * Server-side text extraction for document attachments so the brain can read
 * PDF/DOCX content directly instead of only seeing a `[file: ...]` marker.
 * Every outcome is honest text: extracted content, an explicit empty-layer
 * note, or an explicit failure note — never invented content.
 */

// ponytail: 200k chars keeps a pathological PDF from blowing up the prompt; raise with a real token budget if documents hit it
export const MAX_EXTRACTED_CHARS = 200_000;

export function isExtractableDocument(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType === DOCX_MIME_TYPE;
}

export function extractionFailureNote(error: unknown): string {
  return `(text extraction failed: ${error instanceof Error ? error.message : String(error)})`;
}

export async function extractDocumentText(mimeType: string, bytes: Uint8Array): Promise<string> {
  try {
    if (mimeType === "application/pdf") {
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        // pages[].text only: result.text adds "-- n of N --" page markers that are not document content
        const text = result.pages
          .map((page) => page.text)
          .join("\n")
          .trim();
        return text || "(scanned — no text layer)";
      } finally {
        await parser.destroy();
      }
    }
    if (mimeType === DOCX_MIME_TYPE) {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      const text = result.value.trim();
      return text || "(document contains no extractable text)";
    }
    return "";
  } catch (error) {
    return extractionFailureNote(error);
  }
}

/** The block/prompt section carrying one attachment's extracted text. */
export function extractedTextSection(name: string, text: string): string {
  const body =
    text.length > MAX_EXTRACTED_CHARS
      ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n(truncated — extracted text exceeded ${MAX_EXTRACTED_CHARS} characters)`
      : text;
  return `Extracted text of attached document ${JSON.stringify(name)}:\n"""\n${body}\n"""`;
}

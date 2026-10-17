import { crc32 } from "node:zlib";
import { DOCX_MIME_TYPE } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildSendPrompt, buildUserMessageBlocks } from "./artifacts.js";
import {
  extractDocumentText,
  extractedTextSection,
  isExtractableDocument,
} from "./document-text.js";

/** Minimal single-page PDF; `text` is drawn with one Tj, `null` gives an empty content stream. */
function minimalPdf(text: string | null): Buffer {
  const content = text === null ? "" : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

/** Store-only zip writer — enough to build a minimal DOCX fixture without a zip dependency. */
function zipStore(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const local = Buffer.concat([header, nameBytes, data]);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function minimalDocx(paragraphText: string): Buffer {
  return zipStore([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ]);
}

describe("extractDocumentText", () => {
  it("extracts the text layer of a PDF", async () => {
    const text = await extractDocumentText("application/pdf", minimalPdf("Hello from the report"));
    expect(text).toContain("Hello from the report");
  });

  it("says scanned — no text layer for a PDF without text", async () => {
    const text = await extractDocumentText("application/pdf", minimalPdf(null));
    expect(text).toBe("(scanned — no text layer)");
  });

  it("reports failure honestly instead of inventing content", async () => {
    const text = await extractDocumentText("application/pdf", Buffer.from("not a pdf at all"));
    expect(text.startsWith("(text extraction failed")).toBe(true);
  });

  it("extracts DOCX paragraph text", async () => {
    const text = await extractDocumentText(
      DOCX_MIME_TYPE,
      minimalDocx("Hip fracture follow-up summary"),
    );
    expect(text).toContain("Hip fracture follow-up summary");
  });

  it("recognizes extractable document types", () => {
    expect(isExtractableDocument("application/pdf")).toBe(true);
    expect(isExtractableDocument(DOCX_MIME_TYPE)).toBe(true);
    expect(isExtractableDocument("application/zip")).toBe(false);
  });
});

describe("brain-visible inlining", () => {
  const section = extractedTextSection("report.pdf", "Extracted body text.");

  it("appends extracted text to the run prompt the brain sees", () => {
    const prompt = buildSendPrompt(
      "summarize this",
      [{ name: "report.pdf", mimeType: "application/pdf", size: 12 }],
      [],
      [section],
    );
    expect(prompt).toContain("Extracted body text.");
    expect(prompt.indexOf("summarize this")).toBeLessThan(prompt.indexOf("Extracted body text."));
  });

  it("appends extracted text as a text block on the user message", () => {
    const blocks = buildUserMessageBlocks("summarize this", [], [section]);
    expect(blocks).toContainEqual({ kind: "text", text: section });
  });
});

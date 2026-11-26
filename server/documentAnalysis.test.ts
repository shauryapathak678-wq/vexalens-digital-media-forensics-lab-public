import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyzeDocumentBuffer } from './documentAnalysis';

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files: Array<[string, string | Buffer]>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localRecords.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralRecords.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function makeDocx(options: { metadata?: boolean; revisions?: boolean; embedded?: boolean; badTarget?: boolean } = {}): Buffer {
  const files: Array<[string, string | Buffer]> = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${options.revisions ? '<w:ins w:id="7" w:author="Examiner" w:date="2025-03-04T10:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="8" w:author="Editor"><w:r><w:delText>removed</w:delText></w:r></w:del>' : ''}</w:p></w:body></w:document>`],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r2" Type="external" Target="https://example.invalid/template.dotx" TargetMode="External"/>${options.badTarget ? '<Relationship Id="r3" Type="image" Target="media/missing.png"/>' : ''}</Relationships>`],
  ];
  if (options.metadata) {
    files.push(['docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Case notes</dc:title><dc:creator>Analyst A</dc:creator><cp:lastModifiedBy>Analyst B</cp:lastModifiedBy><dcterms:created>2024-01-01T10:00:00Z</dcterms:created><dcterms:modified>2024-01-02T10:00:00Z</dcterms:modified><cp:revision>3</cp:revision></cp:coreProperties>']);
    files.push(['docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Word</Application><AppVersion>16</AppVersion></Properties>']);
    files.push(['word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>']);
    files.push(['word/comments.xml', '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="Reviewer" w:date="2024-01-03T10:00:00Z">review note</w:comment></w:comments>']);
  }
  if (options.embedded) files.push(['word/embeddings/object1.bin', Buffer.from([0x00, 0x01, 0x02])]);
  return makeZip(files);
}

function makePdf(pageCount = 1): Buffer {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP title</rdf:li></rdf:Alt></dc:title><xmp:CreateDate>2024-01-02T03:04:05Z</xmp:CreateDate></rdf:Description></rdf:RDF></x:xmpmeta>';
  const fileData = Buffer.from('safe attachment', 'utf8');
  const content = Buffer.from('BT ET', 'ascii');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R /Names << /EmbeddedFiles << /Names [(attachment.txt) 7 0 R] >> >> /OpenAction 9 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => ` ${12 + index} 0 R`).join('')}] /Count ${pageCount} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R /Annots [11 0 R] >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('ascii')}\nendstream`,
    `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`,
    '<< /Title (Info title) /Author (Examiner) /CreationDate (D:20240101000000Z) >>',
    '<< /Type /Filespec /F (attachment.txt) /EF << /F 8 0 R >> >>',
    `<< /Type /EmbeddedFile /Length ${fileData.length} >>\nstream\n${fileData.toString('utf8')}\nendstream`,
    '<< /S /JavaScript /JS (app.alert\\(1\\)) >>',
    '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <abcd> >>',
    '<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (note) >>',
  ];
  for (let page = 1; page < pageCount; page += 1) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>');
  }
  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R /ID [<0011223344556677><8899aabbccddeeff>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const updatedInfoOffset = Buffer.byteLength(chunks.join(''));
  chunks.push('6 0 obj\n<< /Title (Info title) /Author (Examiner) /CreationDate (D:20240101000000Z) >>\nendobj\n');
  const updatedXrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n6 1\n${String(updatedInfoOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R /Prev ${xrefOffset} >>\nstartxref\n${updatedXrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

const input = {
  evidenceId: 'evidence-1',
  investigationId: 'case-1',
  uploadedAt: '2024-01-01T00:00:00.000Z',
};

describe('document revision archaeologist parser', () => {
  it('extracts DOCX properties and retained revision structures from package bytes', async () => {
    const bytes = makeDocx({ metadata: true, revisions: true, embedded: true, badTarget: true });
    const original = Buffer.from(bytes);
    const result = await analyzeDocumentBuffer(bytes, { ...input, filename: 'case.docx' });
    expect(result.status).toBe('parsed');
    expect(result.format).toBe('DOCX');
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.properties.title).toBe('Case notes');
    expect(result.properties.lastModifiedBy).toBe('Analyst B');
    expect(result.structure.revisionCounts).toMatchObject({ ins: 1, del: 1 });
    expect(result.structure.comments).toHaveLength(1);
    expect(result.structure.embeddedObjects).toEqual(['word/embeddings/object1.bin']);
    expect(result.structure.externalRelationships).toHaveLength(1);
    expect(result.structure.missingRelationships).toHaveLength(1);
    expect(result.findings.some((item) => item.category === 'revision')).toBe(true);
    expect(result.findings.some((item) => item.category === 'embedded_content')).toBe(true);
    expect(bytes.equals(original)).toBe(true);
  });

  it('reports absent DOCX properties as unavailable rather than a manipulation claim', async () => {
    const result = await analyzeDocumentBuffer(makeDocx(), { ...input, filename: 'empty.docx' });
    expect(result.status).toBe('parsed');
    expect(result.missingMetadata).toContain('creator');
    expect(result.findings.some((item) => item.title === 'Document properties are unavailable')).toBe(true);
    expect(result.findings.every((item) => !/forgery|authentic/i.test(item.title))).toBe(true);
  });

  it('rejects extension/signature mismatches and ZIP path traversal', async () => {
    const wrongSignature = await analyzeDocumentBuffer(Buffer.from('%PDF-1.7'), { ...input, filename: 'wrong.docx' });
    expect(wrongSignature.status).toBe('rejected');
    expect(wrongSignature.errors[0]).toMatch(/not a ZIP-based DOCX/i);

    const traversing = await analyzeDocumentBuffer(makeZip([
      ['[Content_Types].xml', '<Types/>'],
      ['word/document.xml', '<w:document xmlns:w="x"/>'],
      ['../../outside.xml', '<unsafe/>'],
    ]), { ...input, filename: 'traversal.docx' });
    expect(traversing.status).toBe('rejected');
    expect(traversing.errors[0]).toMatch(/path-traversal/i);

    const unsafeXml = makeZip([
      ['[Content_Types].xml', '<Types/>'],
      ['word/document.xml', '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///private">]><w:document xmlns:w="x">&x;</w:document>'],
    ]);
    const xmlResult = await analyzeDocumentBuffer(unsafeXml, { ...input, filename: 'unsafe.docx' });
    expect(xmlResult.status).toBe('rejected');
    expect(xmlResult.errors[0]).toMatch(/DTD|ENTITY/i);
  });

  it('parses PDF metadata, dimensions, incremental markers, actions and embedded attachments', async () => {
    const bytes = makePdf();
    const result = await analyzeDocumentBuffer(bytes, { ...input, filename: 'report.pdf' });
    expect(result.status).toBe('parsed');
    expect(result.properties.title).toBe('Info title');
    expect(result.properties.pageCount).toBe(1);
    expect(result.structure.pageDimensions).toEqual([{ page: 1, width: 612, height: 792 }]);
    expect(result.structure.eofMarkers).toBe(2);
    expect(result.structure.previousXrefReferences).toBe(1);
    expect(result.structure.byteRanges).toBe(1);
    expect(result.structure.javaScriptActions).toBeGreaterThan(0);
    expect(result.structure.embeddedFileMarkers).toBe(1);
    expect(result.findings.some((item) => item.category === 'revision')).toBe(true);
    expect(result.inconsistencies.some((item) => item.label.includes('Info and XMP title'))).toBe(true);
  });

  it('limits PDF page inspection and reports when the configured page cap is exceeded', async () => {
    const previousMaximum = process.env.DOCUMENT_ANALYSIS_MAX_PDF_PAGES;
    process.env.DOCUMENT_ANALYSIS_MAX_PDF_PAGES = '1';
    try {
      const result = await analyzeDocumentBuffer(makePdf(2), { ...input, filename: 'report.pdf' });
      expect(result.status).toBe('partially_parsed');
      expect(result.structure.pageDimensions).toHaveLength(1);
    } finally {
      if (previousMaximum === undefined) delete process.env.DOCUMENT_ANALYSIS_MAX_PDF_PAGES;
      else process.env.DOCUMENT_ANALYSIS_MAX_PDF_PAGES = previousMaximum;
    }
  });

  it('returns a rejected analysis for malformed or unsupported input without fabricated properties', async () => {
    const malformed = await analyzeDocumentBuffer(Buffer.from('%PDF-1.7\nnot a pdf'), { ...input, filename: 'broken.pdf' });
    expect(malformed.status).toBe('rejected');
    expect(malformed.properties).toEqual({});
    expect(malformed.errors).toHaveLength(1);

    const unsupported = await analyzeDocumentBuffer(Buffer.from('anything'), { ...input, filename: 'archive.zip' });
    expect(unsupported.status).toBe('rejected');
    expect(unsupported.format).toBe('UNKNOWN');

    const encryptedPdfBytes = makePdf().toString('latin1').replace(
      /\/Prev \d+ >>/,
      (match) => match.replace(' >>', ' /Encrypt 13 0 R >>')
    );
    const encryptedPdf = await analyzeDocumentBuffer(Buffer.from(encryptedPdfBytes, 'latin1'), { ...input, filename: 'locked.pdf' });
    expect(encryptedPdf.status).toBe('rejected');
    expect(encryptedPdf.errors[0]).toMatch(/encrypted/i);

    const previousMaximum = process.env.DOCUMENT_ANALYSIS_MAX_BYTES;
    process.env.DOCUMENT_ANALYSIS_MAX_BYTES = '16';
    try {
      const oversized = await analyzeDocumentBuffer(Buffer.alloc(17), { ...input, filename: 'large.pdf' });
      expect(oversized.status).toBe('rejected');
      expect(oversized.errors[0]).toMatch(/configured 16-byte/i);
    } finally {
      if (previousMaximum === undefined) delete process.env.DOCUMENT_ANALYSIS_MAX_BYTES;
      else process.env.DOCUMENT_ANALYSIS_MAX_BYTES = previousMaximum;
    }
  });
});

import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import type { Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom';
import type {
  DocumentAnalysisResult,
  DocumentFinding,
  DocumentInconsistency,
} from '../src/types/documentForensics';

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDocumentAnalysisMaxBytes(): number {
  return positiveIntegerSetting('DOCUMENT_ANALYSIS_MAX_BYTES', 20 * 1024 * 1024);
}
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_XML_PACKAGE_BYTES = 20 * 1024 * 1024;
const PARSER_VERSION = 'vexalens-document-analysis/1.0.0';

interface AnalysisInput {
  evidenceId: string;
  investigationId: string;
  filename: string;
  uploadedAt: string;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipPackage {
  entries: ZipEntry[];
  xmlParts: Map<string, Buffer>;
}

function finding(
  category: string,
  severity: DocumentFinding['severity'],
  title: string,
  observation: string,
  source: string,
  technicalExplanation: string,
  recommendedAction: string,
  confidence: DocumentFinding['confidence']['level'] = 'high',
  benignExplanations: string[] = [],
  limitations: string[] = []
): DocumentFinding {
  return {
    id: randomUUID(),
    category,
    severity,
    title,
    observation,
    source,
    technicalExplanation,
    benignExplanations,
    limitations,
    recommendedAction,
    confidence: {
      level: confidence,
      explanation: `Confidence describes the ${confidence} confidence that this specific structural observation was parsed correctly; it is not confidence about authorship, intent, or authenticity.`,
    },
  };
}

function inconsistency(
  label: string,
  status: DocumentInconsistency['status'],
  observations: DocumentInconsistency['observations'],
  recommendedAction: string,
  benignExplanations: string[] = [],
  limitations: string[] = []
): DocumentInconsistency {
  return {
    id: randomUUID(),
    label,
    status,
    observations,
    benignExplanations,
    limitations,
    recommendedAction,
  };
}

function getLocalElements(document: XmlDocument, localName: string): XmlElement[] {
  return Array.from(document.getElementsByTagNameNS('*', localName));
}

function parseXml(xml: Buffer, partName: string): XmlDocument {
  const text = xml.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    throw new Error(`Unsafe XML declaration in ${partName}; external entities and DTDs are not processed.`);
  }
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  }).parseFromString(text, 'application/xml');
  if (errors.length || !document.documentElement) {
    throw new Error(`Malformed XML in ${partName}: ${errors[0] || 'document element is missing'}.`);
  }
  return document;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('DOCX ZIP directory is missing or malformed.');
}

function safeZipName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  return !normalized.startsWith('/') &&
    !/^[a-zA-Z]:/.test(normalized) &&
    normalized.split('/').every((part) => part !== '..' && part !== '.');
}

function readZipEntries(buffer: Buffer): ZipPackage {
  const maxFileBytes = getDocumentAnalysisMaxBytes();
  if (buffer.length < 22 || buffer.length > maxFileBytes) {
    throw new Error(`DOCX file size must be between 22 bytes and ${maxFileBytes} bytes.`);
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
      entryCount > MAX_ZIP_ENTRIES || centralOffset + centralSize > eocd) {
    throw new Error('DOCX uses an unsupported or inconsistent ZIP directory.');
  }
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('DOCX ZIP64 archives are not supported.');
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('DOCX ZIP directory entry is malformed.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > buffer.length) {
      throw new Error('DOCX ZIP entry has an invalid filename or extra field.');
    }
    const name = buffer.toString(flags & 0x0800 ? 'utf8' : 'latin1', nameStart, nameEnd);
    if (!safeZipName(name)) throw new Error('DOCX contains a path-traversal ZIP entry.');
    if (seen.has(name)) throw new Error(`DOCX contains a duplicate ZIP entry: ${name}.`);
    seen.add(name);
    if (flags & 0x0001) throw new Error('Encrypted DOCX packages are not supported.');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method in ${name}.`);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error(`DOCX entry exceeds the per-entry size limit: ${name}.`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_EXPANDED_BYTES) throw new Error('DOCX exceeds the expanded archive size limit.');
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error('DOCX ZIP central directory size does not match its entries.');
  }
  if (seen.has('EncryptionInfo') || seen.has('EncryptedPackage')) {
    throw new Error('Encrypted or password-protected Office packages cannot be analyzed.');
  }

  const xmlParts = new Map<string, Buffer>();
  let totalXmlBytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/') || !/\.(?:xml|rels)$/i.test(entry.name)) continue;
    if (entry.uncompressedSize > MAX_XML_ENTRY_BYTES) {
      throw new Error(`DOCX XML part exceeds the parser limit: ${entry.name}.`);
    }
    totalXmlBytes += entry.uncompressedSize;
    if (totalXmlBytes > MAX_XML_PACKAGE_BYTES) {
      throw new Error('DOCX XML parts exceed the total parser size limit.');
    }
    if (entry.localHeaderOffset + 30 > buffer.length ||
        buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
      throw new Error(`DOCX local ZIP header is malformed for ${entry.name}.`);
    }
    const localFlags = buffer.readUInt16LE(entry.localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(entry.localHeaderOffset + 8);
    const localNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const localNameStart = entry.localHeaderOffset + 30;
    const localName = buffer.toString(localFlags & 0x0800 ? 'utf8' : 'latin1', localNameStart, localNameStart + localNameLength);
    if (localName !== entry.name || localMethod !== entry.method ||
        (localFlags & 0x0001) !== (entry.flags & 0x0001)) {
      throw new Error(`DOCX local and central ZIP headers disagree for ${entry.name}.`);
    }
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw new Error(`DOCX entry data is truncated: ${entry.name}.`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
      throw new Error(`DOCX entry failed size or CRC validation: ${entry.name}.`);
    }
    xmlParts.set(entry.name, data);
  }
  if (!xmlParts.has('[Content_Types].xml') || !xmlParts.has('word/document.xml')) {
    throw new Error('The ZIP file is not a readable Word Open XML document (required package parts are missing).');
  }
  return { entries, xmlParts };
}

function getTextProperty(document: XmlDocument | undefined, name: string): string | null {
  if (!document) return null;
  const element = getLocalElements(document, name)[0];
  const value = element?.textContent?.trim();
  return value || null;
}

function parseDocx(
  buffer: Buffer,
  input: AnalysisInput,
  base: Omit<DocumentAnalysisResult, 'properties' | 'structure' | 'findings' | 'inconsistencies' | 'missingMetadata' | 'limitations' | 'errors' | 'status'>
): DocumentAnalysisResult {
  const archive = readZipEntries(buffer);
  const parts = archive.xmlParts;
  const entries = archive.entries.map((entry) => entry.name);
  const parsePart = (name: string) => {
    const data = parts.get(name);
    return data ? parseXml(data, name) : undefined;
  };
  const core = parsePart('docProps/core.xml');
  const app = parsePart('docProps/app.xml');
  const custom = parsePart('docProps/custom.xml');
  const documentXml = parsePart('word/document.xml');
  const settingsXml = parsePart('word/settings.xml');
  const commentsXml = parsePart('word/comments.xml');
  const textProperties: Record<string, string | null> = {
    title: getTextProperty(core, 'title'),
    subject: getTextProperty(core, 'subject'),
    creator: getTextProperty(core, 'creator'),
    author: getTextProperty(core, 'creator'),
    lastModifiedBy: getTextProperty(core, 'lastModifiedBy'),
    created: getTextProperty(core, 'created'),
    modified: getTextProperty(core, 'modified'),
    revision: getTextProperty(core, 'revision'),
    keywords: getTextProperty(core, 'keywords'),
    description: getTextProperty(core, 'description'),
    application: getTextProperty(app, 'Application'),
    appVersion: getTextProperty(app, 'AppVersion'),
    company: getTextProperty(app, 'Company'),
    template: getTextProperty(app, 'Template'),
  };
  const customProperties: Record<string, string> = {};
  if (custom) {
    for (const property of Array.from(custom.getElementsByTagName('*'))) {
      if (property.localName !== 'property') continue;
      const propertyName = property.getAttribute('name');
      if (propertyName) customProperties[propertyName] = property.textContent?.trim() || '';
    }
  }

  const revisionNames = ['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange'];
  const revisions: Array<{ type: string; id: string | null; author: string | null; date: string | null; part: string }> = [];
  const revisionCounts: Record<string, number> = {};
  for (const name of revisionNames) {
    const matches = getLocalElements(documentXml!, name);
    revisionCounts[name] = matches.length;
    for (const element of matches) {
      if (revisions.length >= 500) break;
      revisions.push({
        type: name,
        id: element.getAttribute('w:id') || element.getAttribute('id') || null,
        author: element.getAttribute('w:author') || element.getAttribute('author') || null,
        date: element.getAttribute('w:date') || element.getAttribute('date') || null,
        part: 'word/document.xml',
      });
    }
  }
  const comments = commentsXml ? getLocalElements(commentsXml, 'comment').map((comment) => ({
    id: comment.getAttribute('w:id') || comment.getAttribute('id') || null,
    author: comment.getAttribute('w:author') || comment.getAttribute('author') || null,
    date: comment.getAttribute('w:date') || comment.getAttribute('date') || null,
  })) : [];
  const trackedRevisionSetting = Boolean(settingsXml && getLocalElements(settingsXml, 'trackRevisions').length);
  const relationshipParts = entries.filter((name) => name.endsWith('.rels'));
  const externalRelationships: Array<{ part: string; id: string | null; target: string | null }> = [];
  const missingRelationships: Array<{ part: string; target: string }> = [];
  const duplicateRelationshipIds: Array<{ part: string; id: string }> = [];
  for (const relationshipPart of relationshipParts) {
    const relXml = parsePart(relationshipPart);
    if (!relXml) continue;
    const ids = new Set<string>();
    for (const relation of Array.from(relXml.getElementsByTagName('*'))) {
      if (relation.localName !== 'Relationship') continue;
      const id = relation.getAttribute('Id');
      const target = relation.getAttribute('Target');
      if (id && ids.has(id)) duplicateRelationshipIds.push({ part: relationshipPart, id });
      if (id) ids.add(id);
      if (relation.getAttribute('TargetMode') === 'External') {
        externalRelationships.push({ part: relationshipPart, id: id || null, target: target || null });
      } else if (target) {
        const ownerDir = relationshipPart === '_rels/.rels' || target.startsWith('/')
          ? ''
          : relationshipPart.replace(/\/_rels\/[^/]+\.rels$/, '/');
        const normalizedTarget = target.replace(/^\/+/, '');
        const segments = `${ownerDir}${normalizedTarget}`.split('/');
        const normalized: string[] = [];
        for (const segment of segments) {
          if (!segment || segment === '.') continue;
          if (segment === '..') normalized.pop();
          else normalized.push(segment);
        }
        const resolved = normalized.join('/');
        if (!entries.includes(resolved)) missingRelationships.push({ part: relationshipPart, target });
      }
    }
  }

  const mediaEntries = entries.filter((name) => /^word\/media\//i.test(name));
  const embeddedEntries = entries.filter((name) => /^word\/embeddings\//i.test(name));
  const customXmlEntries = entries.filter((name) => /^customXml\//i.test(name));
  const headers = entries.filter((name) => /^word\/header\d+\.xml$/i.test(name));
  const footers = entries.filter((name) => /^word\/footer\d+\.xml$/i.test(name));
  const footnotes = entries.includes('word/footnotes.xml');
  const endnotes = entries.includes('word/endnotes.xml');
  const properties: Record<string, string | number | boolean | null> = {
    ...textProperties,
    customProperties: JSON.stringify(customProperties),
  };
  const findings: DocumentFinding[] = [];
  const inconsistencies: DocumentInconsistency[] = [];
  const missingMetadata = Object.entries(textProperties)
    .filter(([key, value]) => value === null && !['appVersion', 'company', 'template'].includes(key))
    .map(([key]) => key);
  if (missingMetadata.length) {
    findings.push(finding('metadata', 'informational', 'Document properties are unavailable',
      `No value was available for: ${missingMetadata.join(', ')}.`,
      'docProps/core.xml; docProps/app.xml',
      'These properties are absent or empty in the parsed Open XML property parts.',
      'Check the source system or other independent records if these values are needed.',
      'high', ['Metadata may have been omitted by the creating application or removed during export.'],
      ['Missing metadata does not establish that the document was altered.']));
  }
  const revisionCount = Object.values(revisionCounts).reduce((sum, count) => sum + count, 0);
  if (textProperties.revision !== null) {
    inconsistencies.push(inconsistency('Declared DOCX revision number and retained revision markup', 'not_comparable', [
      { source: 'docProps/core.xml / revision', value: textProperties.revision },
      { source: 'word/document.xml / detectable revision element count', value: String(revisionCount) },
    ], 'Review the document version with its source application and any independently preserved versions.',
    ['The revision property commonly reflects an application version counter, not a count of retained tracked-change elements.'],
    ['These values measure different things and cannot establish a complete revision history.']));
  }
  const revisionDates = revisions
    .map((revision) => revision.date)
    .filter((date): date is string => Boolean(date) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(date || '') && !Number.isNaN(Date.parse(date || '')))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  if (revisionDates.length && textProperties.modified &&
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(textProperties.modified) &&
      !Number.isNaN(Date.parse(textProperties.modified))) {
    const latestRevisionDate = revisionDates[revisionDates.length - 1];
    const differs = Date.parse(latestRevisionDate) > Date.parse(textProperties.modified);
    inconsistencies.push(inconsistency('DOCX core modification time and latest retained revision time', differs ? 'differ' : 'agree', [
      { source: 'docProps/core.xml / modified', value: textProperties.modified },
      { source: 'word/document.xml / latest retained revision date', value: latestRevisionDate },
    ], 'Compare both values with independent acquisition and source-system records.',
    ['Applications may update document properties independently from revision markup.'],
    ['Only timestamps with explicit timezone offsets are compared; both values remain editable metadata.']));
  }
  if (revisionCount) {
    findings.push(finding('revision', 'informational', 'Revision markup remains in the DOCX package',
      `${revisionCount} revision-related XML element(s) were observed; ${revisions.length} entries are listed with available IDs/authors/timestamps.`,
      'word/document.xml',
      'Tracked insertions, deletions, move markers, or formatting/property change elements are present in the current package.',
      'Review the affected document ranges and preserve a working copy for manual comparison.',
      'high', ['Tracked changes can be part of ordinary collaborative editing.'],
      ['Accepted, rejected, or removed changes are not necessarily retained. The observed markup is not a complete editing history.']));
  }
  if (comments.length) {
    findings.push(finding('revision', 'informational', 'Document comments are present',
      `${comments.length} comment(s) were parsed; author and timestamp values are reported only when present.`,
      'word/comments.xml',
      'Comment records remain in a DOCX package part; no claim is made about who created the values.',
      'Inspect comment references and surrounding text in an authorized document viewer.',
      'high', ['Comments may be expected editorial or review material.'],
      ['Comment content-to-range resolution is not performed by this parser.']));
  }
  if (trackedRevisionSetting) {
    findings.push(finding('revision', 'informational', 'Revision tracking is enabled in document settings',
      'A trackRevisions setting was observed.',
      'word/settings.xml',
      'The package settings include the Word revision-tracking preference.',
      'Compare the setting with document content and the case context.',
      'high', ['This preference may have been enabled for routine collaborative review.'],
      ['A setting does not prove that changes were recorded or that historical edits are complete.']));
  }
  if (embeddedEntries.length) {
    findings.push(finding('embedded_content', 'low', 'Embedded package objects were detected',
      `${embeddedEntries.length} embedded object part(s) were found: ${embeddedEntries.join(', ')}.`,
      'word/embeddings/',
      'Embedded object data is present in the package and was not opened or executed.',
      'Handle embedded objects as separate untrusted evidence using an isolated workflow.',
      'high', ['Embedded objects are commonly used for legitimate Office content.'],
      ['The object payloads are not recursively analyzed.']));
  }
  if (externalRelationships.length) {
    findings.push(finding('relationships', 'low', 'External relationships were detected',
      `${externalRelationships.length} external relationship(s) were found in package relationship parts.`,
      externalRelationships[0].part,
      'The document references resources outside the package; targets are listed in package structure.',
      'Review each target and determine whether external access is expected; do not open links automatically.',
      'high', ['Linked templates and media are common in office workflows.'],
      ['Target availability and remote content were not checked.']));
  }
  if (missingRelationships.length || duplicateRelationshipIds.length) {
    findings.push(finding('package_integrity', 'medium', 'Package relationship irregularities were detected',
      `${missingRelationships.length} internal target(s) were not found and ${duplicateRelationshipIds.length} duplicate relationship ID(s) were observed.`,
      'Package relationship parts',
      'One or more relationship targets are absent from the archive or relationship IDs repeat within a part.',
      'Review the affected relationships with a package-aware Open XML tool and compare a preserved source copy.',
      'high', ['Incomplete export, producer-specific relationships, or package repair may explain irregularities.'],
      ['A structural inconsistency alone does not determine why it occurred.']));
  }
  for (const field of ['created', 'modified'] as const) {
    const value = textProperties[field];
    if (value && Number.isNaN(Date.parse(value))) {
      findings.push(finding('metadata', 'low', `DOCX ${field} timestamp is not parseable`,
        `The stored value is "${value}".`,
        'docProps/core.xml',
        'The value does not parse as a standard date-time string.',
        'Review the raw property with the originating application or another parser.',
        'high', ['Some producers use non-standard property formats.']));
    }
  }
  const created = textProperties.created;
  const modified = textProperties.modified;
  if (created && modified && !Number.isNaN(Date.parse(created)) && !Number.isNaN(Date.parse(modified))) {
    const differs = Date.parse(modified) < Date.parse(created);
    inconsistencies.push(inconsistency('Creation and modification times', differs ? 'differ' : 'agree', [
      { source: 'docProps/core.xml / created', value: created },
      { source: 'docProps/core.xml / modified', value: modified },
    ], 'Compare these properties with independent timestamps and the source acquisition record.',
    ['Clock configuration, timezone conversion, document copying, or metadata rewriting may explain differences.'],
    ['Metadata timestamps are editable and are not independently verified.']));
    if (differs) {
      findings.push(finding('metadata', 'low', 'DOCX modification time precedes creation time',
        `Creation time is ${created}; modification time is ${modified}.`,
        'docProps/core.xml',
        'The parsed modification timestamp is earlier than the parsed creation timestamp.',
        'Correlate with independent system or evidence-intake timestamps.',
        'high', ['Clock skew, timezone handling, or metadata migration may cause this ordering.'],
        ['The property values are not trusted timestamps.']));
    }
  }

  return {
    ...base,
    status: 'parsed',
    properties,
    structure: {
      packageParts: entries.map((name) => ({
        path: name,
        sizeBytes: parts.get(name)?.byteLength ?? archive.entries.find((entry) => entry.name === name)?.uncompressedSize ?? null,
      })),
      revisionCounts,
      revisions,
      trackedRevisionSetting,
      comments,
      embeddedObjects: embeddedEntries,
      imagesAndMedia: mediaEntries,
      charts: entries.filter((name) => /^word\/charts\//i.test(name)),
      externalRelationships,
      missingRelationships,
      duplicateRelationshipIds,
      headers,
      footers,
      footnotes,
      endnotes,
      customXmlEntries,
    },
    findings,
    inconsistencies,
    missingMetadata,
    limitations: [
      'Only the current DOCX package was examined; accepted, rejected, overwritten, or removed historical changes may not be recoverable.',
      'Embedded objects and external resources were identified but not executed, opened, or recursively parsed.',
      'Metadata values are self-reported package data and are not proof of authorship, intent, or document authenticity.',
      revisions.length >= 500 ? 'Revision detail listing is capped at 500 entries.' : '',
    ].filter(Boolean),
    errors: [],
  };
}

function xmpText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return value.map(xmpText).filter(Boolean).join('; ') || null;
  if (value && typeof value === 'object') {
    const values = Object.values(value).map(xmpText).filter(Boolean);
    return values.join('; ') || null;
  }
  return value == null ? null : String(value);
}

function pdfProperty(value: unknown): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return value == null ? null : JSON.stringify(value);
}

function firstPdfDictionary(text: string): string {
  const start = text.indexOf('<<');
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '<<') {
      depth += 1;
      index += 1;
    } else if (pair === '>>') {
      depth -= 1;
      index += 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

function inspectPdfRevisionMarkers(raw: string): {
  eofMarkers: number;
  startXrefMarkers: number;
  previousXrefReferences: number;
  xrefTables: number;
  xrefStreams: number;
  encryptedMarker: boolean;
} {
  const eofMarkers = (raw.match(/(?:^|\r?\n)%%EOF[ \t]*\r?(?=\n|$)/g) || []).length;
  const startXrefs = Array.from(raw.matchAll(/(?:^|\r?\n)startxref[ \t]*\r?\n[ \t]*(\d+)[ \t]*\r?(?=\n|$)/g));
  let startXrefMarkers = 0;
  let previousXrefReferences = 0;
  let xrefTables = 0;
  let xrefStreams = 0;
  let encryptedMarker = false;
  for (const match of startXrefs) {
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= raw.length) continue;
    const section = raw.slice(offset, Math.min(raw.length, offset + 8192));
    let dictionary = '';
    if (/^xref(?:\r?\n|\s)/.test(section)) {
      xrefTables += 1;
      const trailerIndex = section.indexOf('trailer');
      if (trailerIndex >= 0) dictionary = firstPdfDictionary(section.slice(trailerIndex + 'trailer'.length));
    } else {
      const streamIndex = section.indexOf('stream');
      const objectDictionary = streamIndex >= 0 ? section.slice(0, streamIndex) : section;
      if (/\/Type\s*\/XRef\b/.test(objectDictionary)) {
        xrefStreams += 1;
        dictionary = firstPdfDictionary(objectDictionary);
      }
    }
    if (!dictionary) continue;
    startXrefMarkers += 1;
    previousXrefReferences += (dictionary.match(/\/Prev\s+\d+\b/g) || []).length;
    encryptedMarker ||= /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/.test(dictionary);
  }
  return { eofMarkers, startXrefMarkers, previousXrefReferences, xrefTables, xrefStreams, encryptedMarker };
}

async function parsePdf(
  buffer: Buffer,
  input: AnalysisInput,
  base: Omit<DocumentAnalysisResult, 'properties' | 'structure' | 'findings' | 'inconsistencies' | 'missingMetadata' | 'limitations' | 'errors' | 'status'>
): Promise<DocumentAnalysisResult> {
  const maxPdfPages = positiveIntegerSetting('DOCUMENT_ANALYSIS_MAX_PDF_PAGES', 50);
  const timeoutMs = positiveIntegerSetting('DOCUMENT_ANALYSIS_TIMEOUT_MS', 90_000);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
  });
  const analysisDeadline = Date.now() + timeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void loadingTask.destroy().catch((error: unknown) => {
      console.error('[document-analysis] PDF parser timeout cleanup failed:', error instanceof Error ? error.message : 'Unknown cleanup error');
    });
  }, timeoutMs);
  timeout.unref?.();
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (timedOut) throw new Error(`PDF analysis exceeded the ${timeoutMs} ms processing limit.`);
    const raw = buffer.toString('latin1');
    const revisionMarkers = inspectPdfRevisionMarkers(raw);
    if (revisionMarkers.encryptedMarker) {
      throw new Error('Encrypted PDF documents are not supported by this analysis workflow.');
    }
    const { info: rawInfo, metadata } = await document.getMetadata();
    const info = rawInfo as Record<string, unknown>;
    const xmpProperties = {
      title: xmpText(metadata?.get('dc:title')),
      author: xmpText(metadata?.get('dc:creator')),
      subject: xmpText(metadata?.get('dc:description')),
      keywords: xmpText(metadata?.get('pdf:Keywords')),
      creator: xmpText(metadata?.get('xmp:CreatorTool')),
      producer: xmpText(metadata?.get('pdf:Producer')),
      creationDate: xmpText(metadata?.get('xmp:CreateDate')),
      modificationDate: xmpText(metadata?.get('xmp:ModifyDate')),
    };
    const infoProperties = {
      title: pdfProperty(info.Title),
      author: pdfProperty(info.Author),
      subject: pdfProperty(info.Subject),
      keywords: pdfProperty(info.Keywords),
      creator: pdfProperty(info.Creator),
      producer: pdfProperty(info.Producer),
      creationDate: pdfProperty(info.CreationDate),
      modificationDate: pdfProperty(info.ModDate),
      pdfVersion: pdfProperty(info.PDFFormatVersion),
      trapped: pdfProperty(info.Trapped),
      documentId: pdfProperty(info.PDFFileID ?? document.fingerprints?.[0]),
      encrypted: /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/.test(raw),
    };
    const { eofMarkers, startXrefMarkers, previousXrefReferences, xrefTables, xrefStreams } = revisionMarkers;
    const byteRanges = (raw.match(/\/ByteRange\s*\[[^\]]*\]/g) || []).length;
    const signatureDictionaries = (raw.match(/\/Type\s*\/Sig\b/g) || []).length;
    const certificationMarkers = (raw.match(/\/DocMDP\b/g) || []).length;
    const signatureTransformMarkers = (raw.match(/\/TransformMethod\b/g) || []).length;
    const javaScriptActions = (raw.match(/\/(?:JavaScript|JS)\b/g) || []).length;
    const automaticActions = (raw.match(/\/(?:OpenAction|AA)\b/g) || []).length;
    const launchActions = (raw.match(/\/Launch\b/g) || []).length;
    const uriReferences = (raw.match(/\/URI\b/g) || []).length;
    const pageDimensions: Array<{ page: number; width: number; height: number }> = [];
    let annotationCount = 0;
    const formFieldMarkerCount = (raw.match(/\/AcroForm\b/g) || []).length;
    const embeddedFileMarkerCount = (raw.match(/\/EmbeddedFiles\b/g) || []).length;
    const inspectedPageCount = Math.min(document.numPages, maxPdfPages);
    for (let pageNumber = 1; pageNumber <= inspectedPageCount; pageNumber += 1) {
      if (timedOut || Date.now() > analysisDeadline) {
        throw new Error(`PDF analysis exceeded the ${timeoutMs} ms processing limit.`);
      }
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageDimensions.push({ page: pageNumber, width: viewport.width, height: viewport.height });
      const annotations = await page.getAnnotations({ intent: 'display' });
      annotationCount += annotations.length;
      page.cleanup();
    }
    const properties: Record<string, string | number | boolean | null> = {
      ...infoProperties,
      xmp: JSON.stringify(xmpProperties),
      pageCount: document.numPages,
    };
    const findings: DocumentFinding[] = [];
    const inconsistencies: DocumentInconsistency[] = [];
    const missingMetadata = Object.entries({ ...infoProperties, ...xmpProperties })
      .filter(([, value]) => value === null || value === '')
      .map(([key]) => key);
    if (missingMetadata.length) {
      findings.push(finding('metadata', 'informational', 'PDF metadata fields are unavailable',
        `No value was available for: ${[...new Set(missingMetadata)].join(', ')}.`,
        'PDF document information dictionary and XMP metadata',
        'These fields were absent or empty in the parsed metadata structures.',
        'Consult the source system or independent acquisition records if these values are required.',
        'high', ['PDF producers often omit optional metadata.'],
        ['Missing metadata does not establish document manipulation.']));
    }
    if (eofMarkers > 1 || startXrefMarkers > 1 || previousXrefReferences > 0) {
      findings.push(finding('revision', 'informational', 'PDF incremental update indicators were observed',
        `${eofMarkers} %%EOF marker(s), ${startXrefMarkers} startxref marker(s), and ${previousXrefReferences} raw /Prev reference(s) were found.`,
        'PDF byte stream; markers are counted in uncompressed raw bytes',
        'Multiple end markers or /Prev references can indicate incremental revisions retained in the file.',
        'Review the file with a revision-aware PDF tool and compare each revision in context.',
        'moderate', ['Incremental updates are commonly produced by signing, annotation, and ordinary editing.'],
        ['Compressed object streams may hide indicators; this scan does not reconstruct historical object versions or recover deleted content.']));
    }
    if (byteRanges || signatureDictionaries || certificationMarkers || signatureTransformMarkers) {
      findings.push(finding('signature', 'informational', 'PDF signature structures were detected',
        `${signatureDictionaries} signature dictionary marker(s), ${byteRanges} ByteRange array(s), ${certificationMarkers} DocMDP marker(s), and ${signatureTransformMarkers} signature transform marker(s) were found.`,
        'PDF raw bytes; signature markers may be in compressed content',
        'Signature-related structures were detected, but cryptographic integrity and certificate trust were not verified.',
        'Use a trusted signature-validation tool on the preserved original.',
        'moderate', ['Signatures are commonly used to approve or certify documents.'],
        ['Presence of signature data alone does not establish mathematical validity, signer identity, certificate trust, or authenticity.']));
    }
    if (embeddedFileMarkerCount) {
      findings.push(finding('embedded_content', 'low', 'PDF embedded-file markers were detected',
        `${embeddedFileMarkerCount} raw /EmbeddedFiles marker(s) were found.`,
        'PDF raw bytes',
        'The marker may indicate an embedded-file name tree; payloads were not enumerated, opened, or executed.',
        'Handle each embedded file as a separate untrusted evidence item in an isolated workflow.',
        'high', ['PDF attachments are routinely used to include supporting materials.'],
        ['Raw markers do not establish that an attachment is reachable or valid; attachment contents were not analyzed.']));
    }
    if (javaScriptActions || automaticActions || launchActions) {
      findings.push(finding('active_content', 'medium', 'PDF active-action indicators were detected',
        `${javaScriptActions} JavaScript/JS, ${automaticActions} automatic-action, and ${launchActions} Launch marker(s) were found in raw bytes.`,
        'PDF raw bytes',
        'The raw stream contains names associated with active actions; no script or action was executed.',
        'Review the relevant objects with an isolated, read-only PDF inspection tool.',
        'moderate', ['Some benign PDF forms and interactive features use actions.'],
        ['Raw byte matching can miss compressed names and may count markers without resolving object reachability.']));
    }
    if (uriReferences) {
      findings.push(finding('external_reference', 'informational', 'PDF external-reference indicators were detected',
        `${uriReferences} /URI marker(s) were found in raw bytes.`,
        'PDF raw bytes',
        'URI action markers may reference external resources; targets were not followed.',
        'Review each resolved URI target in context without automatically opening it.',
        'low', ['Hyperlinks are common in ordinary PDF documents.'],
        ['This raw scan does not resolve or validate each target.']));
    }
    if (annotationCount || formFieldMarkerCount) {
      findings.push(finding('interactive_content', 'informational', 'PDF form or annotation indicators were detected',
        `${formFieldMarkerCount} raw /AcroForm marker(s) and ${annotationCount} annotation(s) on inspected pages were found.`,
        'PDF raw bytes and inspected page annotation structures',
        'The raw stream contains form markers and/or the inspected pages contain annotations.',
        'Review annotations and form values in a trusted PDF inspection tool.',
        'high', ['Forms and annotations are standard PDF features.'],
        ['Form fields are not enumerated; this analysis does not determine when or by whom these elements were added.']));
    }
    for (const key of ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modificationDate'] as const) {
      const infoValue = infoProperties[key];
      const xmpValue = xmpProperties[key];
      if (infoValue && xmpValue) {
        const valuesMatch = String(infoValue).trim() === String(xmpValue).trim();
        inconsistencies.push(inconsistency(`PDF Info and XMP ${key}`, valuesMatch ? 'agree' : 'differ', [
          { source: `PDF Info / ${key}`, value: String(infoValue) },
          { source: `XMP / ${key}`, value: String(xmpValue) },
        ], 'Compare with application-generated metadata and independent document records.',
        ['Different PDF producers may update Info and XMP independently.'],
        ['Both metadata locations are editable and are not independently verified.']));
        if (!valuesMatch) {
          findings.push(finding('metadata', 'low', `PDF Info and XMP ${key} values differ`,
            `Info dictionary: "${infoValue}"; XMP: "${xmpValue}".`,
            `PDF Info / ${key}; XMP / ${key}`,
            'The same semantic property has different values in the Info dictionary and XMP metadata.',
            'Review both values alongside the PDF revision structure and acquisition context.',
            'high', ['PDF software may update only one metadata representation.'],
            ['A discrepancy does not by itself establish manipulation or malicious intent.']));
        }
      }
    }
    return {
      ...base,
      parserVersions: { ...base.parserVersions, pdf: String(pdfjs.version || 'unknown') },
      status: document.numPages > maxPdfPages ? 'partially_parsed' : 'parsed',
      properties,
      structure: {
        pdfVersion: pdfProperty(info.PDFFormatVersion),
        pageCount: document.numPages,
        pageDimensions,
        encrypted: false,
        permissions: Array.from(await document.getPermissions() || []),
        documentIdentifiers: document.fingerprints || [],
        xmpProperties,
        eofMarkers,
        startXrefMarkers,
        previousXrefReferences,
        xrefTables,
        xrefStreams,
        signatureDictionaries,
        byteRanges,
        certificationMarkers,
        signatureTransformMarkers,
        javaScriptActions,
        automaticActions,
        launchActions,
        uriReferences,
        annotations: annotationCount,
        formFieldMarkers: formFieldMarkerCount,
        embeddedFileMarkers: embeddedFileMarkerCount,
      },
      findings,
      inconsistencies,
      missingMetadata: [...new Set(missingMetadata)],
      limitations: [
        document.numPages > maxPdfPages
          ? `Only the first ${maxPdfPages} pages were inspected; the document contains ${document.numPages} pages.`
          : '',
        'Incremental revision markers were scanned in raw bytes; object-by-object change reconstruction and deleted-content recovery are not implemented.',
        'Signature structures are detected but cryptographic signature integrity, signer identity, and certificate-chain trust are not verified.',
        'PDF actions and embedded attachments were identified but never executed or opened.',
        'Embedded-file and form indicators are raw-byte markers; attachment payloads and form fields are not enumerated.',
        'PDF metadata timestamps are reported as stored; timezone normalization is not assumed.',
        'Object streams may conceal raw-byte indicators; counts are not a complete inventory of all reachable objects.',
      ],
      errors: document.numPages > maxPdfPages
        ? [`Page inspection was limited to the first ${maxPdfPages} pages.`]
        : [],
    };
  } finally {
    clearTimeout(timeout);
    await loadingTask.destroy();
  }
}

export async function analyzeDocumentBuffer(
  buffer: Buffer,
  input: AnalysisInput
): Promise<DocumentAnalysisResult> {
  const analyzedAt = new Date().toISOString();
  const maxFileBytes = getDocumentAnalysisMaxBytes();
  const format = /\.docx$/i.test(input.filename) ? 'DOCX' : /\.pdf$/i.test(input.filename) ? 'PDF' : null;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const base = {
    id: randomUUID(),
    evidenceId: input.evidenceId,
    investigationId: input.investigationId,
    filename: input.filename,
    format: format || 'UNKNOWN',
    fileSize: buffer.length,
    sha256,
    uploadedAt: input.uploadedAt,
    analyzedAt,
    parserVersions: { analyzer: PARSER_VERSION, xml: '@xmldom/xmldom/0.9.12', pdf: 'pdfjs-dist' },
  } satisfies Omit<DocumentAnalysisResult, 'properties' | 'structure' | 'findings' | 'inconsistencies' | 'missingMetadata' | 'limitations' | 'errors' | 'status'>;

  const reject = (message: string): DocumentAnalysisResult => ({
    ...base,
    status: 'rejected',
    properties: {},
    structure: {},
    findings: [],
    inconsistencies: [],
    missingMetadata: [],
    limitations: ['File content was not parsed; no conclusions can be drawn about document metadata or structure.'],
    errors: [message],
  });
  if (!format) return reject('Unsupported file extension. Only .docx and .pdf are accepted.');
  if (buffer.length > maxFileBytes) return reject(`File exceeds the configured ${maxFileBytes}-byte analysis limit.`);
  if (!buffer.length) return reject('The uploaded file is empty.');
  try {
    if (format === 'DOCX') {
      if (buffer.readUInt32LE(0) !== 0x04034b50) {
        return reject('The file is not a ZIP-based DOCX package. Password-protected Office files are unsupported; otherwise the file may be corrupted or mislabeled.');
      }
      return parseDocx(buffer, input, base);
    }
    if (buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf(Buffer.from('%PDF-')) === -1) {
      return reject('The file signature does not contain a PDF header. A PDF file is required for this extension.');
    }
    if (inspectPdfRevisionMarkers(buffer.toString('latin1')).encryptedMarker) {
      return reject('Encrypted or password-protected PDF documents cannot be analyzed.');
    }
    return await parsePdf(buffer, input, base);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The document parser failed unexpectedly.';
    const encrypted = /password|encrypted/i.test(message);
    return {
      ...base,
      status: 'rejected',
      properties: {},
      structure: {},
      findings: [],
      inconsistencies: [],
      missingMetadata: [],
      limitations: ['The parser could not safely read the file; no conclusions can be drawn about document metadata or structure.'],
      errors: [encrypted ? `Encrypted or password-protected documents cannot be analyzed: ${message}` : message],
    };
  }
}

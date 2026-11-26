import { jsPDF } from 'jspdf';
import type { Investigation } from '@/types/forensics';
import type { EmailVerificationRecord, EmailVerifierResult } from '@/types/emailVerifier';

export function generateEmailVerifierReport(
  result: EmailVerifierResult,
  investigation: Investigation,
  record: Pick<EmailVerificationRecord, 'id' | 'createdAt' | 'investigatorNotes' | 'screenshotEvidenceId' | 'emlEvidenceId'>
): Blob {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const contentWidth = width - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > height - margin) {
      pdf.addPage();
      y = margin;
    }
  };
  const section = (title: string) => {
    ensureSpace(12);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(8, 145, 178);
    pdf.text(title.toUpperCase(), margin, y);
    y += 6;
  };
  const line = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? 'Not provided');
    const wrapped = pdf.splitTextToSize(`${label}: ${text || 'Not provided'}`, contentWidth);
    ensureSpace(wrapped.length * 4 + 2);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(51, 65, 85);
    pdf.text(wrapped, margin, y);
    y += wrapped.length * 4 + 2;
  };

  pdf.setFillColor(15, 23, 42);
  pdf.rect(0, 0, width, 34, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(92, 225, 255);
  pdf.text('VEXALENS - EMAIL SCREENSHOT VS ORIGINAL EMAIL', margin, 13);
  pdf.setFontSize(9);
  pdf.setTextColor(226, 232, 240);
  pdf.text('FORENSIC COMPARISON REPORT', margin, 21);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Conclusion: ${result.conclusion}`, margin, 28);
  y = 42;

  section('Case and investigation');
  line('Case name', investigation.title);
  line('Case number', investigation.caseNumber);
  line('Investigation ID', investigation.id);
  line('Verification ID', record.id);
  line('Processed at', result.processedAt);
  line('Report generated', new Date().toISOString());

  section('Evidence integrity');
  line('Screenshot SHA-256', result.screenshot.sha256 || 'Not provided');
  line('Original EML/MSG SHA-256', result.email?.sha256 || 'Not provided');
  line('Screenshot OCR status', result.screenshot.ocr.status);
  line('Screenshot OCR note', result.screenshot.ocr.reason || 'No OCR limitation reported.');
  line('Screenshot evidence ID', record.screenshotEvidenceId || 'Not provided');
  line('Original EML/MSG evidence ID', record.emlEvidenceId || 'Not provided');

  if (result.email) {
    section('Parsed original email');
    const headers = result.email.headers;
    for (const [label, key] of [
      ['From', 'from'], ['To', 'to'], ['CC', 'cc'], ['BCC', 'bcc'], ['Reply-To', 'replyTo'],
      ['Subject', 'subject'], ['Date', 'date'], ['Date UTC', 'dateUtc'],
      ['Date timezone offset', 'dateTimezoneOffset'], ['Date parse status', 'dateStatus'],
      ['Message-ID', 'messageId'], ['In-Reply-To', 'inReplyTo'], ['References', 'references'],
      ['X-Mailer', 'xMailer'], ['User-Agent', 'userAgent'], ['Content-Type', 'contentType'],
      ['Return-Path', 'returnPath'],
    ] as const) {
      line(label, headers[key]);
    }
    line('Plain-text body', result.email.body.plainText || 'Not available');
    line('HTML body (scripts/styles omitted)', result.email.body.htmlText || 'Not available');
    line('Attachments', result.email.attachments.map((file) => ({
      name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256,
    })));
    line('MIME structure', headers.mimeStructure);
    for (const name of ['received', 'returnPath', 'authenticationResults', 'receivedSpf', 'dkimSignature']) {
      line(`${name} headers`, headers[name]);
    }
    if (result.email.intelligence) {
      const intelligence = result.email.intelligence;
      section('Mail delivery path and timing');
      line('Hop count and order', `${intelligence.deliverySummary.hopCount}; ${intelligence.deliverySummary.order}`);
      line('Total recorded delay (seconds)', intelligence.deliverySummary.totalDelaySeconds);
      line('Origin IP candidate', intelligence.deliverySummary.origin);
      line('Country lookup', intelligence.deliverySummary.geoIpNote || 'Local GeoIP result available where reported.');
      for (const [index, hop] of intelligence.deliveryPath.entries()) {
        line(`Hop ${index + 1}`, {
          from: hop.fromHost,
          by: hop.byHost,
          protocol: hop.protocol,
          timestamp: hop.timestampUtc || hop.timestamp,
          ips: hop.ips,
          delayToOlderSeconds: hop.delayToOlderSeconds,
        });
      }

      section('Authentication alignment and threat assessment');
      line('Domain alignment', intelligence.authenticationAlignment);
      line('Heuristic risk score', `${intelligence.risk.level} (${intelligence.risk.score}/100)`);
      for (const finding of intelligence.risk.findings) line('Risk finding', finding);
      line('Recommendation', intelligence.risk.recommendation);

      section('Extracted indicators');
      line('IP addresses', intelligence.artifacts.ips);
      line('Email addresses', intelligence.artifacts.emails);
      line('URLs', intelligence.artifacts.urls);
      line('Reputation lookups', intelligence.artifacts.reputationNote);
    }
  } else {
    section('Parsed original email');
    line('Status', 'No original EML or MSG was provided. Sender identity and original headers cannot be verified.');
  }

  section('Field comparisons');
  for (const [field, comparison] of Object.entries(result.comparisons)) {
    line(`${field} - ${comparison.status}`, `Screenshot: ${comparison.screenshot || 'Not detected'} | Original: ${comparison.original || 'Not provided'}`);
    if (comparison.screenshotOnly?.length) line('Screenshot-only text', comparison.screenshotOnly.join(' '));
    if (comparison.originalOnly?.length) line('Original-only text', comparison.originalOnly.join(' '));
  }
  line('Discrepancies', result.discrepancies.length ? result.discrepancies.join(', ') : 'None observed by the implemented comparisons.');

  section('Screenshot visibility');
  for (const item of result.visibility) line(item.information, `Screenshot: ${item.screenshot} | Original: ${item.original}`);

  section('Email authentication analysis');
  line('SPF', result.email?.authentication.spf || 'Not available');
  line('DKIM recorded result', result.email?.authentication.dkim || 'Not available');
  line('DKIM signature present', result.email?.authentication.dkimSignaturePresent ?? 'Not available');
  line('DMARC', result.email?.authentication.dmarc || 'Not available');
  line('Verification status', result.email?.authentication.verification || 'No EML supplied; authentication unavailable.');

  section('Observations');
  for (const observation of result.observations) {
    line(observation.title, `${observation.description} Status: ${observation.status}. Screenshot value: ${observation.screenshotValue || 'Not detected'}. Original value: ${observation.originalValue || 'Not provided'}.`);
  }
  line('Investigator notes', record.investigatorNotes || 'None recorded.');

  section('Limitations and conclusion');
  for (const limitation of result.limitations) line('Limitation', limitation);
  line('Conclusion', result.conclusion);
  line('Interpretation', 'A match does not prove sender authenticity. A discrepancy does not prove intentional forgery. Findings are limited to the supplied evidence and the deterministic comparisons described in this report.');

  return pdf.output('blob');
}

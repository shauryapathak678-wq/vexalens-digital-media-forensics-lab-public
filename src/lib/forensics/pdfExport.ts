import { jsPDF } from 'jspdf';
import { ForensicReport, ReportCustomization, AnalysisFinding } from '@/types/forensics';
import { SimpleReportContent, formatTimelineDate } from './reportBuilder';
import type { ReportAuthenticationDisplay } from './reportAuthentication';

export interface ExtendedReportOptions {
  mode?: 'simple' | 'detailed';
  language?: 'en' | 'hi';
  simpleContent?: SimpleReportContent;
  customization?: Partial<ReportCustomization>;
  evidenceDetails?: Array<{
    fileName: string;
    mediaType: string;
    sha256: string;
    fileSize: number;
    dimensions?: string;
    camera?: string;
    software?: string;
    inconsistencies?: string[];
  }>;
  provenanceLogs?: Array<{
    action: string;
    actor: string;
    timestamp: string;
    hash: string;
    notes?: string;
  }>;
  certificateRef?: string;
}

async function getPrintableImage(url: string): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (!(url.startsWith('/') && !url.startsWith('//')) && !url.startsWith('blob:') && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) return null;
  if (typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const scale = Math.min(1, 1000 / image.naturalWidth, 1000 / image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }
      try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height });
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function getReportQRCodeDataUrl(existingQr?: string): string {
  return existingQr || '';
}

function drawLabStamp(doc: jsPDF, x: number, y: number, size: number, authenticated: boolean): void {
  const primaryColor: [number, number, number] = authenticated ? [5, 122, 85] : [14, 116, 144];
  doc.setDrawColor(...primaryColor);
  doc.setLineWidth(0.8);
  doc.circle(x + size / 2, y + size / 2, size / 2 - 0.5);
  doc.setLineWidth(0.3);
  doc.circle(x + size / 2, y + size / 2, size / 2 - 2.5);
  doc.circle(x + size / 2, y + size / 2, size / 2 - 5.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(size > 22 ? 5.5 : 4.5);
  doc.setTextColor(...primaryColor);
  doc.text('* VEXALENS FORENSICS LAB *', x + size / 2, y + size * 0.3, { align: 'center' });

  doc.setFontSize(size > 22 ? 7 : 5.5);
  doc.text(authenticated ? 'AUTHENTICATED' : 'PREVIEW ONLY', x + size / 2, y + size * 0.52, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size > 22 ? 4.5 : 3.5);
  doc.text('VEXALENS DIGITAL REPORT', x + size / 2, y + size * 0.72, { align: 'center' });
  doc.text(authenticated ? 'REPORT SIGNED' : 'NOT VERIFIED', x + size / 2, y + size * 0.82, { align: 'center' });
}

function drawLabHeaderLogo(doc: jsPDF, x: number, y: number, width: number, reportId: string, caseNumber: string): void {
  doc.setFillColor(15, 23, 42); // Navy slate
  doc.roundedRect(x, y, width, 26, 2, 2, 'F');
  doc.setFillColor(14, 165, 233); // Cyan accent bar
  doc.rect(x, y, 3.5, 26, 'F');

  // Hexagon/Shield Logo Mark
  const logoX = x + 11;
  const logoY = y + 13;
  doc.setDrawColor(56, 189, 248);
  doc.setLineWidth(0.7);
  doc.roundedRect(logoX - 5, logoY - 6, 10, 12, 1, 1);
  doc.circle(logoX, logoY, 2.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(56, 189, 248);
  doc.text('VEXALENS DIGITAL FORENSICS LABORATORY', x + 22, y + 8);
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('DIGITAL MEDIA SCREENING DOSSIER', x + 22, y + 15.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text(`REPORT ID: ${reportId}   ·   CASE REF: ${caseNumber}`, x + 22, y + 21);
}

function formatReportDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function drawPremiumCoverPage(
  doc: jsPDF,
  details: {
    title: string;
    caseNumber: string;
    reportNumber: string;
    subtitle: string;
    analyst: string;
    agency: string;
    analysisDate: string;
    reportDate: string;
    evidence: Array<{ fileName: string; mimeType: string }>;
    authenticated: boolean;
  }
): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  doc.setFillColor(10, 20, 36);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');
  doc.setDrawColor(27, 49, 70);
  doc.setLineWidth(0.35);
  for (let index = 0; index < 10; index += 1) {
    doc.line(pageWidth - 70 + index * 9, 0, pageWidth, 75 + index * 8);
    doc.line(pageWidth - 54 + index * 7, pageHeight, pageWidth, pageHeight - 48 - index * 7);
  }
  doc.setDrawColor(22, 155, 166);
  doc.setLineWidth(1.1);
  doc.line(margin, 36, margin + 22, 36);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(88, 210, 216);
  doc.text('VEXALENS', margin, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(190, 205, 220);
  doc.text('DIGITAL MEDIA FORENSICS LABORATORY', margin + 26, 30);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(23);
  doc.setTextColor(248, 250, 252);
  doc.text(doc.splitTextToSize('DIGITAL MEDIA FORENSIC ANALYSIS REPORT', pageWidth - margin * 2), margin, 66);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(161, 183, 202);
  doc.text(doc.splitTextToSize(details.subtitle, pageWidth - margin * 2), margin, 83);

  doc.setDrawColor(45, 69, 91);
  doc.setLineWidth(0.45);
  doc.line(margin, 99, pageWidth - margin, 99);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(93, 212, 216);
  doc.text('CONFIDENTIAL — DIGITAL FORENSIC EXAMINATION', margin, 112);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(239, 245, 250);
  doc.text(`CASE ID  ${details.caseNumber}`, margin, 132);
  doc.text(`REPORT ID  ${details.reportNumber}`, margin, 144);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(188, 202, 215);
  doc.text(`Analysis time: ${formatReportDate(details.analysisDate)}`, margin, 159);
  doc.text(`Report generated: ${formatReportDate(details.reportDate)}`, margin, 171);
  doc.text(`Analyst: ${details.analyst || 'Not available'}`, margin, 183);
  doc.text(`Laboratory / agency: ${details.agency || 'Not available'}`, margin, 195);

  doc.setFillColor(18, 34, 52);
  doc.setDrawColor(45, 69, 91);
  doc.roundedRect(margin, 207, pageWidth - margin * 2, 48, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(90, 211, 216);
  doc.text('EVIDENCE EXAMINED', margin + 6, 217);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(230, 237, 244);
  const evidenceLines = details.evidence.length
    ? details.evidence.slice(0, 4).map((item) => `${item.fileName} · ${item.mimeType || 'Type not available'}`)
    : ['No evidence records available'];
  doc.text(doc.splitTextToSize(evidenceLines.join('\n'), pageWidth - margin * 2 - 12).slice(0, 4), margin + 6, 226);
  if (details.evidence.length > 4) {
    doc.setFontSize(7);
    doc.setTextColor(161, 183, 202);
    doc.text(`And ${details.evidence.length - 4} additional evidence item(s); see inventory.`, margin + 6, 249);
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(161, 183, 202);
  doc.text(doc.splitTextToSize(details.title, pageWidth - margin * 2).slice(0, 2), margin, 272);
  doc.setDrawColor(45, 69, 91);
  doc.line(margin, pageHeight - 22, pageWidth - margin, pageHeight - 22);
  doc.setFontSize(7);
  doc.text(details.authenticated ? 'SIGNED REPORT · SEE AUTHENTICATION RECORD' : 'REPORT PREVIEW · NOT AUTHENTICATED', margin, pageHeight - 14);
  doc.text('VEXALENS · CONTROLLED REPORT', pageWidth - margin, pageHeight - 14, { align: 'right' });
}

export async function createSimpleReportPDF(
  content: SimpleReportContent,
  authentication?: ReportAuthenticationDisplay
): Promise<jsPDF> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  const width = pageWidth - margin * 2;
  let y = 43;

  drawPremiumCoverPage(doc, {
    title: content.title,
    caseNumber: content.caseNumber,
    reportNumber: content.reportId,
    subtitle: 'Evidence Examination, Authenticity Assessment & Integrity Verification',
    analyst: content.examinerName || 'Not available',
    agency: content.examinerAgency || 'Not available',
    analysisDate: content.analysisDate,
    reportDate: content.timeline.reportGenerated,
    evidence: content.evidenceGallery.map((entry) => ({ fileName: entry.fileName, mimeType: entry.mimeType })),
    authenticated: Boolean(authentication),
  });
  doc.addPage();
  y = 25;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(15, 32, 52);
  doc.text('VEXALENS · DIGITAL MEDIA FORENSIC ANALYSIS', margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`REPORT ${content.reportId} · CASE ${content.caseNumber}`, pageWidth - margin, 12, { align: 'right' });
  doc.setDrawColor(203, 213, 225);
  doc.line(margin, 16, pageWidth - margin, 16);

  const ensureSpace = (height: number) => {
    if (y + height > pageHeight - 22) {
      doc.addPage();
      y = 20;
    }
  };
  const addText = (label: string, text: string, fontSize = 9) => {
    ensureSpace(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(label, margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSize);
    const lines = doc.splitTextToSize(text, width);
    ensureSpace(lines.length * 4 + 4);
    doc.text(lines, margin, y);
    y += lines.length * 4 + 6;
  };
  // Prominent Bold Notice on First Page
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(153, 27, 27); // Dark Crimson
  const legalNotice = 'This is an automated screening, not a final forensic certificate. Requires expert verification.';
  const legalLines = doc.splitTextToSize(legalNotice, width);
  doc.text(legalLines, margin, y);
  y += legalLines.length * 4 + 4;

  ensureSpace(34);
  doc.setFillColor(246, 249, 251);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(margin, y - 2, width, 30, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  doc.text('EXECUTIVE ASSESSMENT · RECORDED CHECKS ONLY', margin + 4, y + 3);
  doc.setFontSize(10);
  doc.setTextColor(15, 32, 52);
  const conclusionLines = doc.splitTextToSize(content.conclusionLabel, width - 8);
  doc.text(conclusionLines.slice(0, 2), margin + 4, y + 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  const confidenceLines = doc.splitTextToSize(
    `Detector confidence: ${content.confidenceLabel || 'Not assessed'}`,
    width - 8
  );
  doc.text(confidenceLines.slice(0, 1), margin + 4, y + 17);
  const timelineText = `Case registered: ${formatTimelineDate(content.timeline.caseRegistered)} · Evidence received: ${formatTimelineDate(content.timeline.evidenceReceived)} · Report generated: ${formatTimelineDate(content.timeline.reportGenerated)}`;
  doc.text(doc.splitTextToSize(timelineText, width - 8).slice(0, 2), margin + 4, y + 22);
  y += 34;

  addText('Case summary', `${content.title}\n${content.caseSummary}`);

  if (content.evidenceGallery.length > 0) {
    addText(
      'Evidence reviewed',
      content.evidenceGallery
        .map((entry) => `${entry.fileName} · Evidence ID ${entry.evidenceId} · ${entry.sha256 ? `SHA-256 ${entry.sha256}` : 'SHA-256 not available'}`)
        .join('\n'),
      8
    );
    addText(
      'Evidence acquisition and file records',
      content.evidenceGallery
        .map((entry) => `${entry.fileName} · ${entry.mimeType || 'Type not available'} · ${entry.fileSizeBytes} bytes · SHA-256 ${entry.sha256 || 'Not available'}`)
        .join('\n'),
      8
    );
    const uniqueEntries = Array.from(new Map(
      content.evidenceGallery
        .filter((entry) => entry.imageUrl)
        .map((entry) => [entry.sha256 || entry.imageUrl || entry.evidenceId, entry])
    ).values());
    const preparedImages = [];
    for (const entry of uniqueEntries) {
      const image = await getPrintableImage(entry.imageUrl!);
      if (image) preparedImages.push({ entry, image });
    }

    if (preparedImages.length > 0) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(23, 33, 43);
      doc.text('Visual Evidence Comparison (Side-by-Side)', margin, y);
      y += 5;

      const gap = 6;
      const columnWidth = (width - gap) / 2;
      const imageBoxHeight = 44;

      for (let index = 0; index < preparedImages.length; index += 2) {
        const rowImages = preparedImages.slice(index, index + 2);
        ensureSpace(imageBoxHeight + 14);
        rowImages.forEach(({ entry, image }, column) => {
          const x = margin + column * (columnWidth + gap);
          const scale = Math.min(columnWidth / image.width, imageBoxHeight / image.height);
          const imageWidth = image.width * scale;
          const imageHeight = image.height * scale;

          doc.setFillColor(248, 250, 252);
          doc.setDrawColor(226, 232, 240);
          doc.roundedRect(x, y, columnWidth, imageBoxHeight, 1.5, 1.5, 'FD');
          doc.addImage(image.dataUrl, 'JPEG', x + (columnWidth - imageWidth) / 2, y + (imageBoxHeight - imageHeight) / 2, imageWidth, imageHeight);

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(30, 41, 59);
          const roleBadge = column === 0 && rowImages.length > 1 ? '[Baseline Reference] ' : '[Suspect Evidence] ';
          const captionText = `${roleBadge}${entry.fileName}${entry.mediaType === 'video' ? ' · VIDEO FRAME' : ''}`;
          const captionLines = doc.splitTextToSize(captionText, columnWidth);
          doc.text(captionLines.slice(0, 1), x, y + imageBoxHeight + 3.5);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.5);
          doc.setTextColor(100, 116, 139);
          doc.text(`${entry.mediaType === 'video' ? 'Representative video frame · ' : ''}ID: ${entry.evidenceId} · SHA-256: ${entry.sha256 ? entry.sha256.slice(0, 16) + '...' : 'Not available'}`, x, y + imageBoxHeight + 7);
        });
        y += imageBoxHeight + 12;
      }
    }
  }

  ensureSpace(28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 32, 52);
  doc.text('FORENSIC FINDINGS DASHBOARD', margin, y);
  y += 7;
  const statusLabels: Record<string, string> = {
    likely_authentic: 'LIMITED CHECKS ONLY',
    likely_manipulated: 'POTENTIAL ANOMALY',
    inconclusive: 'INCONCLUSIVE',
    unable_to_analyze: 'NOT TESTED',
    checked: 'TESTED / RECORDED',
  };
  for (let index = 0; index < content.domainConclusions.length; index += 2) {
    const row = content.domainConclusions.slice(index, index + 2);
    ensureSpace(27);
    row.forEach((domain, column) => {
      const cardX = margin + column * (width / 2 + 3);
      const cardWidth = (width - 3) / 2;
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(203, 213, 225);
      doc.roundedRect(cardX, y, cardWidth, 23, 1.5, 1.5, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 32, 52);
      doc.text(doc.splitTextToSize(domain.label, cardWidth - 6).slice(0, 1), cardX + 3, y + 5);
      doc.setFontSize(6.5);
      doc.setTextColor(15, 118, 128);
      doc.text(statusLabels[domain.state] || 'NOT TESTED', cardX + 3, y + 10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(71, 85, 105);
      doc.setFontSize(6);
      const noteLines = doc.splitTextToSize(domain.note, cardWidth - 6);
      doc.text(noteLines.slice(0, 2), cardX + 3, y + 14);
    });
    y += 26;
  }

  addText(
    'Findings by question',
    content.domainConclusions.map((domain) => `${domain.label}: ${domain.state.replace(/_/g, ' ')} — ${domain.note}`).join('\n')
  );

  const findingDetails = content.findingDetails || [];
  const mediaSections = [
    { title: 'PHOTO OBSERVATIONS', mediaType: 'image' },
    { title: 'VIDEO OBSERVATIONS', mediaType: 'video' },
    { title: 'AUDIO OBSERVATIONS', mediaType: 'audio' },
    { title: 'DOCUMENT AND SCREENSHOT OBSERVATIONS', mediaType: 'document' },
    { title: 'OTHER EVIDENCE OBSERVATIONS', mediaType: 'other' },
  ];
  if (findingDetails.length) {
    for (const section of mediaSections) {
      const matchingFindings = findingDetails.filter((finding) => content.evidenceGallery
        .some((entry) => entry.evidenceId === finding.evidenceId && (section.mediaType === 'other'
          ? !['image', 'video', 'audio', 'document'].includes(entry.mediaType)
          : entry.mediaType === section.mediaType)));
      addText(section.title, matchingFindings.length
        ? matchingFindings.map((finding) => {
            const fileName = content.evidenceGallery.find((entry) => entry.evidenceId === finding.evidenceId)?.fileName || finding.evidenceId;
            return `${fileName} · ${finding.observedEvidence}\nExplanation: ${finding.simpleExplanation || finding.plainEnglishSummary || 'No explanation recorded.'}`;
          }).join('\n\n')
        : 'No observations recorded.');
    }
    const deepfakeFindings = findingDetails.filter((finding) => finding.category === 'synthetic_deepfake');
    addText('DEEPFAKE FINDINGS', deepfakeFindings.length
      ? deepfakeFindings.map((finding) => {
          const fileName = content.evidenceGallery.find((entry) => entry.evidenceId === finding.evidenceId)?.fileName || finding.evidenceId;
          return `${fileName} · ${finding.observedEvidence}\nExplanation: ${finding.simpleExplanation || finding.plainEnglishSummary || 'No explanation recorded.'}`;
        }).join('\n\n')
      : 'No deepfake findings recorded.');
  } else {
    for (const section of mediaSections) addText(section.title, 'No observations recorded.');
    addText('DEEPFAKE FINDINGS', 'No deepfake findings recorded.');
  }

  if (content.certificates?.length) {
    addText('CERTIFICATES', content.certificates.map((certificate) =>
      `${certificate.certificateId} · ${certificate.fileName} · Status: ${certificate.status} · SHA-256: ${certificate.sha256Hash || 'Not available'}`
    ).join('\n'));
  } else {
    addText('CERTIFICATES', 'No certificates are recorded for this case.');
  }
  if (content.provenance?.length) {
    addText('CHAIN OF CUSTODY', content.provenance.map((event) =>
      `${formatTimelineDate(event.timestamp)} · ${event.actionType.replace(/_/g, ' ')} · ${event.actor || 'Actor not recorded'} · SHA-256: ${event.recordedSha256 || 'Not available'} · ${event.notes || 'No notes recorded.'}`
    ).join('\n'));
  } else {
    addText('CHAIN OF CUSTODY', 'No chain-of-custody events are recorded for this case.');
  }

  addText('What does this mean?', content.whatThisMeans);
  addText('What should I do next?', content.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'));
  addText('Technical terms explained', content.glossary.map((entry) => `${entry.term}: ${entry.plain}`).join('\n'), 8);
  addText('Limitations and uncertainty', content.limitations, 8);
  addText('Evidence IDs', content.evidenceIds.length ? content.evidenceIds.join(', ') : 'None');

  // Examiner Signature, Lab Stamp & Real Verification QR Code (Rendered when authenticated)
  if (authentication) {
    const qrDataUrl = getReportQRCodeDataUrl(authentication.qrDataUrl);

    ensureSpace(58);
    doc.setDrawColor(203, 213, 225);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(margin, y, width, 52, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 32, 52);
    doc.text('EXAMINER SIGNATURE & FORENSIC CERTIFICATION', margin + 4, y + 6.5);

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(15, 32, 52);
    doc.text('Electronically signed', margin + 4, y + 17);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.3);
    doc.line(margin + 4, y + 23, margin + 55, y + 23);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(15, 23, 42);
    doc.text(authentication.record.examinerName || 'Examiner not available', margin + 4, y + 27);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Signed: ${formatReportDate(authentication.record.issuedAt)} · Key: ${authentication.record.keyId}`, margin + 4, y + 31);
    doc.text(`Report SHA-256: ${authentication.record.reportHash}`, margin + 4, y + 35);

    // Official Lab Stamp in the center
    drawLabStamp(doc, margin + 68, y + 8, 26, true);

    // Real QR Code on the right
    if (qrDataUrl) {
      doc.addImage(qrDataUrl, 'PNG', pageWidth - margin - 32, y + 4, 28, 28);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      doc.setTextColor(15, 32, 52);
      doc.text('Scan for Report ID Verification', pageWidth - margin - 32, y + 34);
      doc.setFont('courier', 'normal');
      doc.setFontSize(5);
      doc.setTextColor(100, 116, 139);
      doc.text(content.reportId.slice(0, 24), pageWidth - margin - 32, y + 37.5);
    }
    doc.setFont('courier', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      doc.splitTextToSize(`Digital signature: ${authentication.record.signature}`, width - 8),
      margin + 4,
      y + 44
    );
    y += 58;
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 2; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.setDrawColor(203, 213, 225);
    doc.line(margin, 12, pageWidth - margin, 12);
    doc.text(`VEXALENS · REPORT ${content.reportId} · ${content.caseNumber}`, margin, 9);
    doc.line(margin, pageHeight - 13, pageWidth - margin, pageHeight - 13);
    doc.text('Technical assessment · interpret within the documented scope', margin, pageHeight - 8);
    doc.text(`Page ${page - 1} of ${pageCount - 1}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  return doc;
}

/**
 * Generates a local PDF summary of the supplied case and finding data
 * Supports user-driven customization (sections, explanation depth, logo, filter severity, and cover page)
 */
export function createForensicReportPDF(
  report: ForensicReport,
  options?: ExtendedReportOptions,
  authentication?: ReportAuthenticationDisplay
): Promise<jsPDF> {
  return createForensicReportPDFAsync(report, options, authentication);
}

async function createForensicReportPDFAsync(
  report: ForensicReport,
  options?: ExtendedReportOptions,
  authentication?: ReportAuthenticationDisplay
): Promise<jsPDF> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const custom = options?.customization;
  const explanationLevel = custom?.explanationLevel || 'both';
  const severityFilter = custom?.severityFilter || 'all';

  // Filter findings based on user configuration
  let findingsToPrint: AnalysisFinding[] = report.findings;
  if (severityFilter === 'critical_only') {
    findingsToPrint = findingsToPrint.filter((f: AnalysisFinding) => f.severity === 'critical');
  } else if (severityFilter === 'high_critical') {
    findingsToPrint = findingsToPrint.filter((f: AnalysisFinding) => f.severity === 'critical' || f.severity === 'high');
  }

  const ensureSpace = (neededHeight: number) => {
    if (y + neededHeight > pageHeight - 20) {
      doc.addPage();
      y = margin + 5;
    }
  };
  const addDetailedText = (label: string, text: string) => {
    const lines = doc.splitTextToSize(text, contentWidth);
    ensureSpace(lines.length * 3.5 + 12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 32, 52);
    doc.text(label, margin, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);
    doc.text(lines, margin, y);
    y += lines.length * 3.5 + 5;
  };

  const hasCoverPage = custom?.includedSections?.coverPage !== false;
  if (hasCoverPage) {
    const availableAnalysisDate = options?.simpleContent?.analysisDate ||
      report.findings.find((finding) => finding.createdAt)?.createdAt ||
      'Not available';
    drawPremiumCoverPage(doc, {
      title: report.title,
      caseNumber: report.caseNumber,
      reportNumber: report.reportNumber,
      subtitle: custom?.reportTitle || 'Evidence Examination, Authenticity Assessment & Integrity Verification',
      analyst: custom?.leadInvestigator || report.leadInvestigator || 'Not available',
      agency: custom?.agency || report.agency || 'Not available',
      analysisDate: availableAnalysisDate,
      reportDate: custom?.reportDate || report.createdAt,
      evidence: report.evidenceList.map((item) => ({
        fileName: item.fileName,
        mimeType: item.mimeType || 'Type not available',
      })),
      authenticated: Boolean(authentication),
    });
    doc.addPage();
    y = margin + 5;
  } else {
    drawLabHeaderLogo(doc, margin, y, contentWidth, report.reportNumber, report.caseNumber);
    y += 30;
  }

  const dashboardItems = options?.simpleContent?.domainConclusions || [];
  ensureSpace(27);
  doc.setFillColor(246, 249, 251);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(margin, y, contentWidth, 18, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(15, 32, 52);
  doc.text('FORENSIC FINDINGS DASHBOARD', margin + 4, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  doc.text(
    dashboardItems.length
      ? 'Status cards below reflect only the saved analysis records; no overall authenticity claim is made.'
      : `${findingsToPrint.length} recorded finding(s); domain summary is not available.`,
    margin + 4,
    y + 11
  );
  y += 23;
  const domainStatus: Record<string, string> = {
    likely_authentic: 'LIMITED CHECKS ONLY',
    likely_manipulated: 'POTENTIAL ANOMALY',
    inconclusive: 'INCONCLUSIVE',
    unable_to_analyze: 'NOT TESTED',
    checked: 'CHECKED',
  };
  for (let index = 0; index < dashboardItems.length; index += 2) {
    const row = dashboardItems.slice(index, index + 2);
    ensureSpace(26);
    row.forEach((domain, column) => {
      const cardWidth = (contentWidth - 4) / 2;
      const cardX = margin + column * (cardWidth + 4);
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(203, 213, 225);
      doc.roundedRect(cardX, y, cardWidth, 22, 1.2, 1.2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(15, 32, 52);
      doc.text(doc.splitTextToSize(domain.label, cardWidth - 6).slice(0, 1), cardX + 3, y + 5);
      doc.setFontSize(6.2);
      doc.setTextColor(15, 118, 128);
      doc.text(domainStatus[domain.state] || 'NOT TESTED', cardX + 3, y + 9.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(71, 85, 105);
      const note = doc.splitTextToSize(domain.note, cardWidth - 6);
      doc.text(note.slice(0, 2), cardX + 3, y + 13.5);
    });
    y += 25;
  }
  if (options?.simpleContent) {
    ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 32, 52);
    doc.text('FINAL CONCLUSION', margin, y);
    y += 5;
    doc.setFontSize(8.5);
    const conclusion = doc.splitTextToSize(options.simpleContent.conclusionLabel, contentWidth);
    doc.text(conclusion, margin, y);
    y += conclusion.length * 4 + 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    const explanation = doc.splitTextToSize(options.simpleContent.whatThisMeans, contentWidth);
    ensureSpace(explanation.length * 3.7 + 5);
    doc.text(explanation, margin, y);
    y += explanation.length * 3.7 + 5;
  }

  // Section 1: Executive Summary
  if (custom?.includedSections?.executiveSummary !== false) {
    ensureSpace(35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('1. EXECUTIVE SUMMARY & OBJECTIVE STATEMENT', margin, y);
    y += 5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    const summaryText = custom?.customExecutiveSummary || report.summary;
    const summaryLines = doc.splitTextToSize(summaryText, contentWidth);
    doc.text(summaryLines, margin, y);
    y += summaryLines.length * 4.5 + 6;
  }

  // Section 2: Evidence Inventory & SHA-256 Hashes
  if (custom?.includedSections?.evidenceInventory !== false) {
    ensureSpace(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('2. EVIDENCE INVENTORY & RECORDED HASH VALUES', margin, y);
    y += 5;

    // Table Header
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(71, 85, 105);
    doc.text('EVIDENCE / FILE', margin + 3, y + 4.2);
    doc.text('FORMAT / SIZE', margin + 77, y + 4.2);
    doc.text('SHA-256', margin + 122, y + 4.2);
    y += 7.5;

    doc.setFont('helvetica', 'normal');
    const visualItemsToPrint: Array<{ item: typeof report.evidenceList[number]; preview: { dataUrl: string; width: number; height: number } }> = [];

    for (const item of report.evidenceList) {
      const labelLines = doc.splitTextToSize(`${item.id} · ${item.fileName}`, 70);
      const hashLines = item.hashStatus === 'calculated'
        ? doc.splitTextToSize(item.sha256, 65)
        : ['Not available'];
      const rowHeight = Math.max(labelLines.length, hashLines.length) * 2.6 + 4;
      ensureSpace(rowHeight + 2);
      doc.setFontSize(7.3);
      doc.setTextColor(15, 23, 42);
      doc.text(labelLines, margin + 3, y + 3.2);
      doc.setTextColor(71, 85, 105);
      const fileSize = item.fileSizeBytes < 1024 * 1024
        ? `${(item.fileSizeBytes / 1024).toFixed(1)} KB`
        : `${(item.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`;
      const formatSize = doc.splitTextToSize(`${item.mimeType || item.mediaType} · ${fileSize}`, 41);
      doc.text(formatSize, margin + 77, y + 3.2);
      doc.setFont('courier', 'normal');
      doc.setFontSize(5.2);
      doc.text(hashLines, margin + 122, y + 3.2);
      doc.setFont('helvetica', 'normal');

      y += rowHeight;
      doc.setDrawColor(241, 245, 249);
      doc.line(margin, y, margin + contentWidth, y);

      const reportEvidence = report.evidenceList.find((entry) => entry.id === item.id);
      const displayUrl = reportEvidence?.thumbnailUrl || reportEvidence?.previewUrl;
      if ((reportEvidence?.mediaType === 'image' || reportEvidence?.mediaType === 'video') && displayUrl) {
        const preview = await getPrintableImage(displayUrl);
        if (preview && !visualItemsToPrint.some((v) => v.item.sha256 === item.sha256)) {
          visualItemsToPrint.push({ item, preview });
        }
      }
    }
    y += 4;

    // Side-by-side Visual Evidence Comparison (Dono images ko sath me rakho up niche nhi)
    if (visualItemsToPrint.length > 0) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text('VISUAL EVIDENCE COMPARISON (SIDE-BY-SIDE)', margin, y);
      y += 5;

      const gap = 6;
      const columnWidth = (contentWidth - gap) / 2;
      const imageBoxHeight = 44;

      for (let index = 0; index < visualItemsToPrint.length; index += 2) {
        const rowImages = visualItemsToPrint.slice(index, index + 2);
        ensureSpace(imageBoxHeight + 14);
        rowImages.forEach(({ item, preview }, column) => {
          const x = margin + column * (columnWidth + gap);
          const scale = Math.min(columnWidth / preview.width, imageBoxHeight / preview.height);
          const imageWidth = preview.width * scale;
          const imageHeight = preview.height * scale;

          doc.setFillColor(248, 250, 252);
          doc.setDrawColor(226, 232, 240);
          doc.roundedRect(x, y, columnWidth, imageBoxHeight, 1.5, 1.5, 'FD');
          doc.addImage(preview.dataUrl, 'JPEG', x + (columnWidth - imageWidth) / 2, y + (imageBoxHeight - imageHeight) / 2, imageWidth, imageHeight);

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(30, 41, 59);
          const roleLabel = item.isOriginal ? '[Baseline Reference] ' : '[Suspect Evidence] ';
          doc.text(`${roleLabel}${item.fileName}${item.mediaType === 'video' ? ' · VIDEO FRAME' : ''}`, x, y + imageBoxHeight + 3.5);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.5);
          doc.setTextColor(100, 116, 139);
          doc.text(`${item.mediaType === 'video' ? 'Representative video frame · ' : ''}ID: ${item.id} · SHA-256: ${item.sha256 ? item.sha256.slice(0, 18) + '...' : 'Not available'}`, x, y + imageBoxHeight + 7);
        });
        y += imageBoxHeight + 12;
      }
    }

    const metadataItems = report.evidenceList.filter((item) => Object.keys(item.metadata || {}).length > 0);
    if (metadataItems.length > 0) {
      ensureSpace(22);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('AVAILABLE METADATA AND ENCODING', margin, y);
      y += 5;
      for (const item of metadataItems) {
        const metadata = item.metadata;
        const details = [
          metadata.fileFormat && `Format: ${metadata.fileFormat}`,
          metadata.dateTimeOriginal && `Date/time original: ${metadata.dateTimeOriginal}`,
          metadata.dateTimeDigitized && `Date/time digitized: ${metadata.dateTimeDigitized}`,
          metadata.dimensions && `Dimensions: ${metadata.dimensions.width} × ${metadata.dimensions.height}`,
          metadata.colorSpace && `Color space: ${metadata.colorSpace}`,
          metadata.colorProfile && `Color profile: ${metadata.colorProfile}`,
          metadata.cameraMake && `Camera make: ${metadata.cameraMake}`,
          metadata.cameraModel && `Camera model: ${metadata.cameraModel}`,
          metadata.software && `Software tag: ${metadata.software}`,
          metadata.audioSpecs?.sampleRateHz && `Sample rate: ${metadata.audioSpecs.sampleRateHz} Hz`,
          metadata.audioSpecs?.channels && `Channels: ${metadata.audioSpecs.channels}`,
          metadata.videoSpecs?.videoCodec && `Video codec: ${metadata.videoSpecs.videoCodec}`,
          metadata.videoSpecs?.durationSec && `Duration: ${metadata.videoSpecs.durationSec} seconds`,
          metadata.inconsistenciesDetected?.length && `Recorded metadata observations: ${metadata.inconsistenciesDetected.join('; ')}`,
          metadata.missingMetadataNotices?.length && `Missing metadata notes: ${metadata.missingMetadataNotices.join('; ')}`,
        ].filter(Boolean).join(' · ') || 'No supported metadata fields were available.';
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        const lines = doc.splitTextToSize(`${item.id} · ${item.fileName}: ${details}`, contentWidth);
        ensureSpace(lines.length * 3.5 + 5);
        doc.text(lines, margin, y);
        y += lines.length * 3.5 + 4;
      }
      y += 3;
    }
  }

  const provenanceLogs = options?.provenanceLogs || (report.provenance || []).map((event) => ({
    action: event.actionType.replace(/_/g, ' '),
    actor: event.actor,
    timestamp: event.timestamp,
    hash: event.recordedSha256,
    notes: event.notes,
  }));
  if (provenanceLogs.length) {
    ensureSpace(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 32, 52);
    doc.text('RECORDED CHAIN-OF-CUSTODY EVENTS', margin, y);
    y += 5;
    for (const event of provenanceLogs) {
      const lines = doc.splitTextToSize(
        `${formatReportDate(event.timestamp)} · ${event.action} · ${event.actor || 'Actor not available'} · SHA-256 ${event.hash || 'Not available'} · ${event.notes || 'No notes recorded.'}`,
        contentWidth
      );
      ensureSpace(lines.length * 3.5 + 4);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(51, 65, 85);
      doc.text(lines, margin, y);
      y += lines.length * 3.5 + 3;
    }
    y += 3;
  } else {
    addDetailedText('RECORDED CHAIN OF CUSTODY', 'No chain-of-custody events are recorded for this case.');
  }

  if (report.certificates?.length) {
    addDetailedText('CERTIFICATES', report.certificates.map((certificate) =>
      `${certificate.certificateId} · ${certificate.fileName} · Status: ${certificate.status} · SHA-256: ${certificate.sha256Hash || 'Not available'} · Issued: ${formatTimelineDate(certificate.analysisTimestamp)} · Examiner: ${certificate.examinerName || 'Not available'}`
    ).join('\n') + '\nThese certificates record file details; they do not prove who created the file or that its contents are true.');
  } else {
    addDetailedText('CERTIFICATES', 'No certificates are recorded for this case.');
  }

  // Section 3: Detailed Forensic Findings with 8-Question Explainability
  ensureSpace(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('3. RECORDED FINDINGS AND OBSERVATIONS', margin, y);
  y += 5;

  const evidenceMediaById = new Map(report.evidenceList.map((item) => [item.id, item.mediaType]));
  const mediaFindingGroups = [
    { title: 'PHOTO OBSERVATIONS', mediaType: 'image' },
    { title: 'VIDEO OBSERVATIONS', mediaType: 'video' },
    { title: 'AUDIO OBSERVATIONS', mediaType: 'audio' },
    { title: 'DOCUMENT AND SCREENSHOT OBSERVATIONS', mediaType: 'document' },
    { title: 'OTHER EVIDENCE OBSERVATIONS', mediaType: 'other' },
  ].flatMap((group) => [{
    title: group.title,
    findings: findingsToPrint.filter((finding) => group.mediaType === 'other'
      ? !['image', 'video', 'audio', 'document'].includes(evidenceMediaById.get(finding.evidenceId) || '')
      : evidenceMediaById.get(finding.evidenceId) === group.mediaType),
  }]);
  mediaFindingGroups.push({
    title: 'DEEPFAKE FINDINGS',
    findings: findingsToPrint.filter((finding) => finding.category === 'synthetic_deepfake'),
  });
  const categorizedFindings = mediaFindingGroups.flatMap((group) => group.findings.map((finding) => ({
    sectionTitle: group.title,
    finding,
  })));

  if (categorizedFindings.length === 0) {
    for (const group of mediaFindingGroups) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15, 32, 52);
      doc.text(group.title, margin, y);
      y += 5;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text('No observations recorded.', margin, y);
      y += 6;
    }
  } else {
    for (const group of mediaFindingGroups.filter((candidate) => candidate.findings.length === 0)) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15, 32, 52);
      doc.text(group.title, margin, y);
      y += 5;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text('No observations recorded.', margin, y);
      y += 6;
    }
    let activeFindingSection = '';
    for (let i = 0; i < categorizedFindings.length; i++) {
      const { sectionTitle, finding: f } = categorizedFindings[i];
      if (sectionTitle !== activeFindingSection) {
        ensureSpace(10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 32, 52);
        doc.text(sectionTitle, margin, y);
        y += 5;
        activeFindingSection = sectionTitle;
      }
      ensureSpace(42);

      // Finding Header Box
      doc.setDrawColor(226, 232, 240);
      doc.setFillColor(f.severity === 'critical' ? 254 : f.severity === 'high' ? 255 : 248, f.severity === 'critical' ? 242 : f.severity === 'high' ? 247 : 250, f.severity === 'critical' ? 242 : f.severity === 'high' ? 237 : 252);
      doc.roundedRect(margin, y, contentWidth, 8, 1, 1, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(f.severity === 'critical' ? 185 : f.severity === 'high' ? 194 : 30, f.severity === 'critical' ? 28 : f.severity === 'high' ? 65 : 41, 59);
      doc.text(`Finding 3.${i + 1}: ${f.title} [SEVERITY: ${f.severity.toUpperCase()}]`, margin + 4, y + 5.5);

      y += 11;

      ensureSpace(15);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text('RECORDED OBSERVATION:', margin + 3, y);
      y += 4;
      doc.setFontSize(8.5);
      const observationLines = doc.splitTextToSize(f.observedEvidence || 'No observation recorded.', contentWidth - 6);
      doc.text(observationLines, margin + 3, y);
      y += observationLines.length * 4 + 3;

      // 1. Simple Explanation
      if (explanationLevel === 'both' || explanationLevel === 'simple') {
        ensureSpace(16);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(15, 23, 42);
        doc.text('Plain-English Assessment:', margin + 3, y);
        y += 4;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 65, 85);
        const simpLines = doc.splitTextToSize(f.simpleExplanation || f.plainEnglishSummary || '', contentWidth - 6);
        doc.text(simpLines, margin + 3, y);
        y += simpLines.length * 4 + 3;
      }

      // 2. Technical Explanation & Evidence Location
      if (explanationLevel === 'both' || explanationLevel === 'technical') {
        ensureSpace(18);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(15, 23, 42);
        doc.text('Technical Measurements & Signal Observations:', margin + 3, y);
        y += 4;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 65, 85);
        const techLines = doc.splitTextToSize(f.technicalExplanation || f.observedEvidence || '', contentWidth - 6);
        doc.text(techLines, margin + 3, y);
        y += techLines.length * 4 + 3;

        if (f.evidenceLocation?.label) {
          ensureSpace(8);
          doc.setFontSize(7.5);
          doc.setTextColor(14, 116, 144);
          doc.text(`Identified Region: ${f.evidenceLocation.label} ${f.evidenceLocation.timestampStart ? `(${f.evidenceLocation.timestampStart} - ${f.evidenceLocation.timestampEnd})` : ''}`, margin + 3, y);
          y += 4.5;
        }
      }

      // 3. Reliability, False Positives & Alternatives
      ensureSpace(16);
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      const notes = `Method: ${f.detectionMethod || 'Not supplied'} · Reliability: ${f.methodReliability || 'Not assessed'} · Alternative Explanations: ${f.potentialFalsePositives || 'Not supplied'}`;
      const noteLines = doc.splitTextToSize(notes, contentWidth - 6);
      doc.text(noteLines, margin + 3, y);
      y += noteLines.length * 3.5 + 6;

      if (typeof f.rawDetectorScore === 'number' || typeof f.confidenceScore === 'number') {
        ensureSpace(10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        const scoreText = [
          typeof f.rawDetectorScore === 'number' && `Raw model score: ${f.rawDetectorScore}${f.scoreInterpretation ? ` (${f.scoreInterpretation})` : ''}`,
          typeof f.confidenceScore === 'number' && `Calibrated score: ${f.confidenceScore}`,
        ].filter(Boolean).join(' · ');
        const scoreLines = doc.splitTextToSize(scoreText, contentWidth - 6);
        doc.text(scoreLines, margin + 3, y);
        y += scoreLines.length * 3.5 + 5;
      }
    }
  }

  // Section 4: Recommended Next Steps
  if (custom?.recommendedNextSteps || report.disclaimers?.length) {
    ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text(custom?.recommendedNextSteps ? '4. RECOMMENDED NEXT STEPS' : '4. RECORDED LIMITATIONS', margin, y);
    y += 5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    const steps = custom?.recommendedNextSteps || report.disclaimers?.join('\n') || 'No limitations were supplied.';
    const stepLines = doc.splitTextToSize(steps, contentWidth);
    doc.text(stepLines, margin, y);
    y += stepLines.length * 4 + 6;
  }

  // Section 5: Legal & Methodological Disclaimers
  ensureSpace(28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(100, 116, 139);
  doc.text('5. LIMITATIONS & DISCLAIMER', margin, y);
  y += 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  const disclaimers = [
    'Automated observations do not independently establish truth, authorship, or legal authenticity.',
    'ELA is a recompression diagnostic and is not an AI-origin or manipulation classifier.',
    'Puter AI Image Detection is an experimental visual-language-model opinion, not a validated specialist detector or proof of image origin.',
    'A calculated SHA-256 digest identifies file bytes; it does not independently establish authorship or authenticity.',
  ];

  for (const d of disclaimers) {
    doc.text(d, margin, y);
    y += 3.5;
  }
  y += 6;

  // Signed report record
  if (authentication) {
    const qrDataUrl = getReportQRCodeDataUrl(authentication.qrDataUrl);

    ensureSpace(58);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.roundedRect(margin, y, contentWidth, 52, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text('EXAMINER SIGNATURE & FORENSIC CERTIFICATION', margin + 4, y + 6.5);

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(15, 32, 52);
    doc.text('Electronically signed', margin + 4, y + 17);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.3);
    doc.line(margin + 4, y + 23, margin + 55, y + 23);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(15, 23, 42);
    doc.text(authentication.record.examinerName || 'Examiner not available', margin + 4, y + 27);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Examiner badge: ${authentication.record.examinerBadge || 'Not available'}`, margin + 4, y + 31);
    doc.text(`Report SHA-256: ${authentication.record.reportHash}`, margin + 4, y + 35);

    // Official Forensic Stamp in middle
    drawLabStamp(doc, margin + 70, y + 8, 26, true);

    // Real QR Code on right
    if (qrDataUrl) {
      doc.addImage(qrDataUrl, 'PNG', pageWidth - margin - 32, y + 4, 28, 28);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      doc.setTextColor(15, 23, 42);
      doc.text('Scan for Report ID Verification', pageWidth - margin - 32, y + 34);
      doc.setFont('courier', 'normal');
      doc.setFontSize(5);
      doc.setTextColor(100, 116, 139);
      doc.text(report.reportNumber.slice(0, 24), pageWidth - margin - 32, y + 37.5);
    }
    doc.setFont('courier', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      doc.splitTextToSize(`Digital signature: ${authentication.record.signature}`, contentWidth - 8),
      margin + 4,
      y + 44
    );
    y += 58;
  }

  // Add footer on EVERY page
  const totalPages = doc.getNumberOfPages();
  const firstBodyPage = hasCoverPage ? 2 : 1;
  const bodyPageCount = totalPages - firstBodyPage + 1;
  for (let p = firstBodyPage; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.setDrawColor(203, 213, 225);
    doc.line(margin, 12, pageWidth - margin, 12);
    doc.text(`VEXALENS · REPORT ${report.reportNumber} · ${report.caseNumber}`, margin, 9);
    doc.line(margin, pageHeight - 13, pageWidth - margin, pageHeight - 13);
    doc.text('Technical assessment · interpret within the documented scope', margin, pageHeight - 8);
    doc.text(`Page ${p - firstBodyPage + 1} of ${bodyPageCount}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  return doc;
}

export async function exportForensicReportPDF(
  report: ForensicReport,
  options?: ExtendedReportOptions,
  authentication?: ReportAuthenticationDisplay
): Promise<void> {
  const doc = await createForensicReportPDF(report, options, authentication);
  doc.save(getReportFilename(report.caseNumber, report.reportNumber));
}

export async function exportSimpleReportPDF(
  content: SimpleReportContent,
  authentication?: ReportAuthenticationDisplay
): Promise<void> {
  const doc = await createSimpleReportPDF(content, authentication);
  doc.save(getReportFilename(content.caseNumber, content.reportId));
}

function getReportFilename(caseNumber: string, reportNumber: string): string {
  const sanitize = (value: string) =>
    value.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'UNASSIGNED';
  return `VexaLens_Forensic_Report_${sanitize(caseNumber)}_${sanitize(reportNumber)}.pdf`;
}

import QRCode from 'qrcode';
import { jsPDF } from 'jspdf';
import { EvidenceCertificate, EvidenceItem, Investigation, UserProfile } from '@/types/forensics';

/**
 * Requests a server-side HMAC record for the supplied evidence details
 */
export async function issueEvidenceCertificate(
  evidence: EvidenceItem,
  investigation: Investigation,
  user: UserProfile,
  algorithmsApplied: string[] = ['SHA-256', 'EXIF', 'DCT-ELA']
): Promise<EvidenceCertificate> {
  const response = await fetch('/api/certificates/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evidenceId: evidence.id,
      investigationId: investigation.id,
      caseNumber: investigation.caseNumber,
      fileName: evidence.fileName,
      fileSizeBytes: evidence.fileSize,
      sha256Hash: evidence.sha256Hash,
      uploadTimestamp: evidence.createdAt,
      algorithmsApplied,
      examinerName: user.fullName,
      examinerBadge: user.badgeNumber,
      agency: user.agency,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.certificate) {
    throw new Error(data.error || 'Server certificate signing is unavailable.');
  }
  return data.certificate;
}

/**
 * Generates a downloadable PDF record of the supplied certificate fields
 */
export async function exportEvidenceCertificatePDF(cert: EvidenceCertificate): Promise<void> {
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

  // Generate QR Code as DataURL
  const qrDataUrl = await QRCode.toDataURL(
    JSON.stringify({
      certId: cert.certificateId,
      sha256: cert.sha256Hash,
      manifest: cert.manifestHash,
      sig: cert.signature,
    }),
    { margin: 1, width: 180, color: { dark: '#0f172a', light: '#ffffff' } }
  );

  // Outer border with security guilloche style
  doc.setDrawColor(30, 41, 59);
  doc.setLineWidth(1.2);
  doc.roundedRect(10, 10, pageWidth - 20, pageHeight - 20, 2, 2);

  doc.setDrawColor(51, 65, 85);
  doc.setLineWidth(0.3);
  doc.rect(13, 13, pageWidth - 26, pageHeight - 26);

  // Certificate Header
  y = 22;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(14, 116, 144); // Cyan-700
  doc.text('VEXALENS EVIDENCE INTEGRITY RECORD', pageWidth / 2, y, { align: 'center' });

  y += 8;
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42); // Navy-900
  doc.text('EVIDENCE INTEGRITY RECORD', pageWidth / 2, y, { align: 'center' });

  y += 5;
  doc.setFont('courier', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`CERTIFICATE IDENTIFIER: ${cert.certificateId}`, pageWidth / 2, y, { align: 'center' });

  y += 10;
  doc.setDrawColor(226, 232, 240);
  doc.line(margin + 5, y, pageWidth - margin - 5, y);

  // Certification Preamble
  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(51, 65, 85);
  const preamble =
    'This record reports evidence details and a server-generated HMAC over the recorded manifest, when configured. It does not independently establish authenticity, authorship, or chain of custody outside this application.';
  const preambleLines = doc.splitTextToSize(preamble, contentWidth);
  doc.text(preambleLines, margin, y);

  y += preambleLines.length * 5 + 6;

  // Evidence Specification Table Box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(margin, y, contentWidth, 54, 1, 1, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);

  const row = (label: string, val: string, curY: number, mono = false) => {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(100, 116, 139);
    doc.text(label, margin + 4, curY);
    doc.setFont(mono ? 'courier' : 'helvetica', mono ? 'bold' : 'normal');
    doc.setTextColor(15, 23, 42);
    doc.text(val, margin + 55, curY);
  };

  row('Artifact Filename:', cert.fileName, y + 7);
  row('File Byte Length:', `${cert.fileSizeBytes.toLocaleString()} bytes`, y + 14);
  row('Cryptographic SHA-256:', cert.sha256Hash, y + 21, true);
  row('Associated Case Ref:', cert.caseNumber, y + 28, true);
  row('Evidence Ingestion Time:', cert.uploadTimestamp, y + 35, true);
  row('Forensic Analysis Time:', cert.analysisTimestamp, y + 42, true);
  row('Software Engine Version:', cert.softwareVersion, y + 49);

  y += 62;

  // Cryptographic Manifest & Signature Details
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('MANIFEST HASH & SERVER HMAC', margin, y);

  y += 6;
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(margin, y, contentWidth - 45, 32, 1, 1, 'FD');

  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.setFont('helvetica', 'bold');
  doc.text('Manifest Hash (SHA-256):', margin + 3, y + 6);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.text(cert.manifestHash, margin + 3, y + 11);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('HMAC Authentication Code:', margin + 3, y + 18);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.text(cert.signature, margin + 3, y + 23);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text(`Signing Key ID: ${cert.verificationPublicKeyId} · Status: ${cert.status.toUpperCase()}`, margin + 3, y + 29);

  // Add QR code on the right
  doc.addImage(qrDataUrl, 'PNG', pageWidth - margin - 40, y, 32, 32);

  y += 40;

  // Methodologies Applied
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('ANALYSIS METHODOLOGIES APPLIED', margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  doc.text(`Algorithms Applied: ${cert.algorithmsApplied.join(', ')}`, margin, y);

  y += 8;

  // Legal Limitations Disclaimer
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text('LEGAL NOTICES & INTEGRITY SCOPE', margin, y);
  y += 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  const legalText =
    'A matching SHA-256 digest establishes byte identity only against a separately retained digest. HMAC verification requires the configured server secret and an available server record. This document does not establish who created the media, whether it depicts a real event, or whether evidence handling outside this application was reliable.';
  const legalLines = doc.splitTextToSize(legalText, contentWidth);
  doc.text(legalLines, margin, y);

  y += legalLines.length * 3.8 + 12;

  // Supplied examiner details are not an electronic signature.
  doc.setDrawColor(148, 163, 184);
  doc.line(margin, y + 10, margin + 65, y + 10);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(cert.examinerName, margin, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Badge #${cert.examinerBadge} · ${cert.agency}`, margin, y + 18);

  doc.line(pageWidth - margin - 65, y + 10, pageWidth - margin, y + 10);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text('Server HMAC record', pageWidth - margin - 65, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('No external trust registry', pageWidth - margin - 65, y + 18);

  doc.save(`VexaLens-Certificate-${cert.certificateId}.pdf`);
}

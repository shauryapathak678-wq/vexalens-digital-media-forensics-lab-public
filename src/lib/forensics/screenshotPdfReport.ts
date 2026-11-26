import { jsPDF } from 'jspdf';
import { ScreenshotAnalysisResult } from '@/types/screenshotForensics';
import type { PersistedScreenshotAnalysis } from '@/lib/supabase-sync';

export function generateScreenshotForensicPdf(
  result: ScreenshotAnalysisResult,
  caseNumber: string = 'CASE-AUTOGEN',
  examinerName: string = 'Digital Forensics Unit',
  savedAnalyses: PersistedScreenshotAnalysis[] = []
): Blob {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const contentWidth = pageWidth - margin * 2;
  let y = 18;

  const checkPageBreak = (neededHeight: number) => {
    if (y + neededHeight > pageHeight - 16) {
      pdf.addPage();
      y = 18;
      // Header on subsequent pages
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 139);
      pdf.text(`VexaLens Digital Forensics Laboratory · Case: ${caseNumber} · Evidence: ${result.fileName}`, margin, 10);
      pdf.setDrawColor(226, 232, 240);
      pdf.line(margin, 12, pageWidth - margin, 12);
    }
  };

  // Header Banner
  pdf.setFillColor(15, 23, 42); // slate-900
  pdf.rect(margin, y, contentWidth, 22, 'F');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(6, 182, 212); // cyan-500
  pdf.text('VEXALENS DIGITAL MEDIA FORENSICS LAB', margin + 6, y + 9);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(226, 232, 240);
  pdf.text('EXPLORATORY SCREENSHOT MANIPULATION REVIEW', margin + 6, y + 16);
  y += 28;

  // Case & Evidence Metadata Card
  checkPageBreak(38);
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(226, 232, 240);
  pdf.rect(margin, y, contentWidth, 34, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(30, 41, 59);
  pdf.text('EVIDENCE & EXAMINATION SPECIFICATION', margin + 5, y + 6);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(71, 85, 105);

  const leftX = margin + 5;
  const midX = margin + contentWidth / 2;

  pdf.text(`Case Reference: ${caseNumber}`, leftX, y + 12);
  pdf.text(`Evidence Filename: ${result.fileName}`, leftX, y + 17);
  pdf.text(`Media Format: ${result.fileType.toUpperCase()} (${result.imageDimensions.width}x${result.imageDimensions.height} px)`, leftX, y + 22);
  pdf.text(`Category: ${result.category.toUpperCase().replace('_', ' ')} SCREENSHOT`, leftX, y + 27);

  pdf.text(`Analysis ID: ${result.id}`, midX, y + 12);
  pdf.text(`File Size: ${(result.fileSize / 1024).toFixed(1)} KB`, midX, y + 17);
  pdf.text(`Analysis Timestamp: ${new Date(result.analysisTimestamp).toLocaleString()}`, midX, y + 22);
  pdf.text(`Examiner: ${examinerName}`, midX, y + 27);
  pdf.text(`EXIF metadata: ${result.imageMetadata.exifAvailable ? 'available' : 'not present'}`, midX, y + 32);
  pdf.text(`Saved analyses in case: ${savedAnalyses.length + 1}`, leftX, y + 32);
  y += 5;
  y += 38;

  // File digests identify bytes; they do not prove authenticity.
  checkPageBreak(18);
  pdf.setFillColor(241, 245, 249);
  pdf.rect(margin, y, contentWidth, 14, 'F');
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`SHA-256: ${result.sha256}`, margin + 4, y + 5.5);
  pdf.text(`MD5:     ${result.md5}`, margin + 4, y + 10.5);
  y += 18;

  // Executive Assessment Banner
  checkPageBreak(28);
  let statusColor: [number, number, number] = [16, 185, 129]; // Emerald
  if (result.assessmentStatus === 'potential_manipulation') {
    statusColor = [239, 68, 68]; // Red
  } else if (result.assessmentStatus === 'inconclusive') {
    statusColor = [245, 158, 11]; // Amber
  }

  pdf.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  pdf.rect(margin, y, contentWidth, 10, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(255, 255, 255);
  pdf.text(`OVERALL ASSESSMENT: ${result.assessmentSummary.toUpperCase()}`, margin + 6, y + 7);
  y += 14;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(51, 65, 85);
  const explLines = pdf.splitTextToSize(result.assessmentExplanation, contentWidth);
  pdf.text(explLines, margin, y);
  y += explLines.length * 4.5 + 2;

  // Plain-language observation with the method clearly separated from certainty.
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(203, 213, 225);
  pdf.rect(margin, y, contentWidth, 10, 'FD');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`Simple Observation: [${result.simpleVerdict || 'Needs review'}]`, margin + 4, y + 4.5);
  pdf.setFont('helvetica', 'italic');
  pdf.setTextColor(71, 85, 105);
  pdf.text(result.easyWordsSummary || 'In easy words: The implemented checks did not determine whether this image was edited.', margin + 4, y + 8);
  y += 14;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(71, 85, 105);
  const methodLines = pdf.splitTextToSize(`Assessment method: ${result.assessmentMethod}`, contentWidth);
  checkPageBreak(methodLines.length * 3.8 + 5);
  pdf.text(methodLines, margin, y);
  y += methodLines.length * 3.8 + 4;

  if (result.annotatedDataUrl || result.heatmapDataUrl) {
    pdf.addPage();
    y = 18;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(15, 23, 42);
    pdf.text('ANALYSIS IMAGES — ORIGINAL PIXELS PRESERVED', margin, y);
    y += 8;
    const imageWidth = Math.min(contentWidth, 120);
    const imageHeight = Math.min(205, imageWidth * result.imageDimensions.height / result.imageDimensions.width);
    for (const [label, imageUrl] of [
      ['Flagged regions', result.annotatedDataUrl],
      ['Measured overlay map', result.heatmapDataUrl],
    ] as const) {
      if (!imageUrl) continue;
      checkPageBreak(imageHeight + 16);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.text(label, margin, y);
      y += 4;
      pdf.addImage(imageUrl, margin, y, imageWidth, imageHeight);
      y += imageHeight + 8;
    }
  }

  // Suspicious Regions Summary
  checkPageBreak(30);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`IDENTIFIED SUSPICIOUS REGIONS (${result.suspiciousRegions.length})`, margin, y);
  y += 6;

  if (result.suspiciousRegions.length === 0) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(8.5);
    pdf.setTextColor(100, 116, 139);
    pdf.text('No discrete localized manipulation clusters were identified across the screenshot canvas.', margin, y);
    y += 8;
  } else {
    for (const reg of result.suspiciousRegions) {
      checkPageBreak(28);
      pdf.setDrawColor(203, 213, 225);
      pdf.setFillColor(254, 242, 242);
      pdf.rect(margin, y, contentWidth, 24, 'FD');

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8.5);
      pdf.setTextColor(185, 28, 28);
      pdf.text(`Region #${reg.regionNumber}: ${reg.label} [${reg.signalLevel.toUpperCase()}]`, margin + 4, y + 5);

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7.5);
      pdf.setTextColor(5, 150, 105);
      pdf.text(`Simple Observation: ${reg.simpleObservation || 'Altered Content'} (${reg.easyWords || ''})`, margin + 4, y + 9.5);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(71, 85, 105);
      pdf.text(`Checks: ${reg.technique} · Coordinates: [x:${reg.pixelBox.x}, y:${reg.pixelBox.y}, w:${reg.pixelBox.width}, h:${reg.pixelBox.height}]`, margin + 4, y + 14);

      const reasonText = pdf.splitTextToSize(`Reason: ${reg.reason}`, contentWidth - 8);
      pdf.text(reasonText, margin + 4, y + 18);
      y += 28;
    }
  }

  // Technical Detection Modules Findings
  checkPageBreak(30);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(15, 23, 42);
  pdf.text('TECHNICAL MODULE BREAKDOWN', margin, y);
  y += 6;

  const modules = Object.values(result.moduleFindings);
  for (const mod of modules) {
    checkPageBreak(22);
    pdf.setDrawColor(226, 232, 240);
    pdf.setFillColor(248, 250, 252);
    pdf.rect(margin, y, contentWidth, 18, 'FD');

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    const modColor = mod.status === 'flagged' ? [180, 83, 9] : mod.status === 'clean' ? [5, 150, 105] : [71, 85, 105];
    pdf.setTextColor(modColor[0], modColor[1], modColor[2]);
    pdf.text(`${mod.name} [Status: ${mod.status.toUpperCase()}]`, margin + 4, y + 5);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(71, 85, 105);
    const foundText = pdf.splitTextToSize(`Findings: ${mod.whatWasFound}`, contentWidth - 8);
    pdf.text(foundText, margin + 4, y + 9.5);
    const thresholdText = pdf.splitTextToSize(
      `Thresholds: ${JSON.stringify(mod.thresholds)} · Metrics: ${JSON.stringify(mod.metrics)}`,
      contentWidth - 8
    );
    pdf.text(thresholdText, margin + 4, y + 14.5);
    y += 22;
  }

  const exifEntries = Object.entries(result.imageMetadata.exif);
  if (exifEntries.length > 0) {
    checkPageBreak(15);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(15, 23, 42);
    pdf.text('EXIF METADATA', margin, y);
    y += 5;
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(71, 85, 105);
    for (const [key, value] of exifEntries) {
      const lines = pdf.splitTextToSize(`${key}: ${value}`, contentWidth);
      checkPageBreak(lines.length * 3.5 + 2);
      pdf.text(lines, margin, y);
      y += lines.length * 3.5 + 1;
    }
  }

  checkPageBreak(15);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`OCR-EXTRACTED TEXT (${result.ocrText.length} words)`, margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(71, 85, 105);
  const ocrText = result.ocrText.length
    ? result.ocrText.map((word) => `${word.text} [x:${word.box.x}, y:${word.box.y}, w:${word.box.width}, h:${word.box.height}]`).join(' · ')
    : 'No OCR text was extracted. OCR may be unavailable or the image may contain no readable text.';
  const ocrLines = pdf.splitTextToSize(ocrText, contentWidth);
  for (const line of ocrLines) {
    checkPageBreak(4);
    pdf.text(line, margin, y);
    y += 3.5;
  }

  const priorAnalyses = savedAnalyses.filter((analysis) => analysis.id !== result.id);
  if (priorAnalyses.length) {
    checkPageBreak(18);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(15, 23, 42);
    pdf.text(`SAVED SCREENSHOT ANALYSES IN THIS INVESTIGATION (${priorAnalyses.length})`, margin, y);
    y += 6;
    for (const analysis of priorAnalyses) {
      const summary = [
        `${analysis.fileName} · ${analysis.imageDimensions.width}×${analysis.imageDimensions.height} · ${analysis.fileType}`,
        `SHA-256: ${analysis.sha256}`,
        `Assessment: ${analysis.assessmentSummary}`,
        `Regions: ${analysis.suspiciousRegions.length}; OCR words: ${analysis.ocrText.length}`,
        ...Object.values(analysis.moduleFindings).map((module) => `${module.name}: ${module.status} — ${module.whatWasFound}`),
        ...analysis.suspiciousRegions.map((region) =>
          `Region ${region.regionNumber} [${region.signalLevel}] ${region.technique} at ${region.pixelBox.x},${region.pixelBox.y},${region.pixelBox.width},${region.pixelBox.height}`
        ),
      ];
      const text = pdf.splitTextToSize(summary.join('\n'), contentWidth);
      checkPageBreak(text.length * 3.6 + 8);
      pdf.setFont('courier', 'normal');
      pdf.setFontSize(6.5);
      pdf.setTextColor(71, 85, 105);
      pdf.text(text, margin, y);
      y += text.length * 3.3 + 5;
    }
  }

  // Statutory Disclaimers & Methodology Limitations
  checkPageBreak(30);
  pdf.setDrawColor(203, 213, 225);
  pdf.setFillColor(241, 245, 249);
  pdf.rect(margin, y, contentWidth, 22, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(30, 41, 59);
  pdf.text('METHOD LIMITATIONS & DISCLAIMER', margin + 4, y + 5);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.8);
  pdf.setTextColor(100, 116, 139);
  const disclaimerLines = pdf.splitTextToSize(
    'This report contains exploratory backend OpenCV measurements and is not a validated forensic opinion. Flagged differences may result from benign rendering, resizing, compression, or repeated interface graphics and do not prove editing, fraud, authorship, or intent. A lack of flagged regions does not prove authenticity. Thresholds are recorded but are not calibrated accuracy probabilities; no labeled field dataset was available. Verify important claims using the original file and issuing platform.',
    contentWidth - 8
  );
  pdf.text(disclaimerLines, margin + 4, y + 9);

  return pdf.output('blob');
}

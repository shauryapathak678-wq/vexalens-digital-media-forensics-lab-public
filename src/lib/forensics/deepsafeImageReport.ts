import { jsPDF } from 'jspdf';
import { formatDeepSafeScore, type DeepSafeImageAnalysis } from './deepsafeImageDetector';

export function downloadDeepSafeImageReport(analysis: DeepSafeImageAnalysis): void {
  const document = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const left = 14;
  const width = 182;
  const bottom = 282;
  let y = 18;

  const addText = (text: string, fontSize = 9, lineHeight = 4.5, bold = false) => {
    document.setFont('helvetica', bold ? 'bold' : 'normal');
    document.setFontSize(fontSize);
    const lines = document.splitTextToSize(text, width) as string[];
    if (y + lines.length * lineHeight > bottom) {
      document.addPage();
      y = 16;
    }
    document.text(lines, left, y);
    y += lines.length * lineHeight + 2;
  };

  document.setFont('helvetica', 'bold');
  document.setFontSize(16);
  document.text('VexaLens AI Image Deepfake Analysis', left, y);
  y += 9;
  addText('Preliminary model screening only. A model prediction is not a verified forensic fact. A non-flagged result does not prove authenticity.', 8, 4);
  addText(`Assessment: ${analysis.ensemble.assessment.replace(/_/g, ' ')}`, 11, 5, true);
  addText(`Investigation ID: ${analysis.investigation_id}`);
  addText(`Evidence ID: ${analysis.evidence_id}`);
  addText(`Filename: ${analysis.file_name}`);
  addText(`Format: ${analysis.image.format} (${analysis.mime_type})`);
  addText(`Size: ${analysis.file_size.toLocaleString()} bytes`);
  addText(`Dimensions: ${analysis.image.width} × ${analysis.image.height}`);
  addText(`SHA-256: ${analysis.image.sha256}`);
  addText(`Analyzed: ${new Date(analysis.analyzed_at).toLocaleString()}`);
  addText(`Processing status: ${analysis.processing_status}`);
  addText(`Fusion: ${analysis.ensemble.method}`);
  addText(analysis.analysis_version === '1.1.0'
    ? 'No validated aggregate verdict or decision threshold is applied.'
    : 'Legacy result: the earlier thresholded voting workflow was used; this is not a validated forensic verdict.');

  addText('Observations', 11, 5, true);
  analysis.ensemble.observations.forEach((observation) => addText(`- ${observation}`));

  addText('Individual model results', 11, 5, true);
  Object.values(analysis.models).forEach((model) => {
    addText(`${model.model_name} (${model.model_version}) — ${model.status}`, 10, 4.5, true);
    addText(`Uncalibrated sigmoid fake-class score: ${model.score === null ? 'Not available' : formatDeepSafeScore(model.score)}`);
    addText(`Raw model logit: ${model.raw_logit?.toFixed(6) ?? 'Not reported'}`);
    addText(`Score meaning: ${model.score_meaning}`);
    if (model.error) addText(`Error: ${model.error}`);
    addText(`Raw output: ${JSON.stringify(model.raw_output)}`);
  });

  addText('Technical details', 11, 5, true);
  addText(`Provider revision: ${analysis.provider_revision}`);
  addText(`Analysis version: ${analysis.analysis_version}`);
  addText(`Processing duration: ${analysis.duration_ms} ms`);
  if (analysis.error_detail) addText(`Analysis error: ${analysis.error_detail}`);
  addText(
    'Limitations: The detector scores are uncalibrated model outputs and can be affected by image compression, resizing, unseen generators, and domain shift. Seek independent corroboration.',
    8,
    4,
  );

  const safeName = analysis.file_name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'evidence';
  document.save(`VexaLens-DeepSafe-${safeName}.pdf`);
}

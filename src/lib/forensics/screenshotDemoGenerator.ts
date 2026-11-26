import type { ScreenshotAnalysisResult } from '@/types/screenshotForensics';

// ---------------------------------------------------------------------------
// Demo canvas generator
// ---------------------------------------------------------------------------

/**
 * Generates a synthetic but realistic payment receipt screenshot (UPI / Mobile Banking)
 * containing an edited/doctored amount field for instant interactive demonstration.
 * Highlights inconsistent font edge sharpness, altered background pixels, and ELA discrepancy.
 */
export async function createDemoPaymentScreenshot(): Promise<{ file: File; dataUrl: string }> {
  const width = 720;
  const height = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Canvas 2D context not available');
  }

  // 1. Mobile Phone App Background (Modern dark slate / deep navy UPI theme)
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(0.3, '#091e36');
  bgGrad.addColorStop(1, '#020617');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Status Bar (Time, Battery, Wifi)
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 22px system-ui, -apple-system, sans-serif';
  ctx.fillText('09:41', 40, 50);
  ctx.fillText('5G 88%', width - 120, 50);

  // App Header
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
  ctx.fillText('UPI Pay Direct · Payment Receipt', 40, 110);
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 135);
  ctx.lineTo(width - 40, 135);
  ctx.stroke();

  // Success Circle Icon
  const centerX = width / 2;
  const iconY = 220;
  ctx.beginPath();
  ctx.arc(centerX, iconY, 52, 0, Math.PI * 2);
  ctx.fillStyle = '#059669';
  ctx.fill();
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 4;
  ctx.stroke();

  // White Checkmark
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(centerX - 24, iconY);
  ctx.lineTo(centerX - 6, iconY + 18);
  ctx.lineTo(centerX + 26, iconY - 16);
  ctx.stroke();

  // Success Label
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 28px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Payment Successful', centerX, 315);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '20px system-ui, -apple-system, sans-serif';
  ctx.fillText('Transferred to ElectroMart Digital Retails', centerX, 350);

  // =========================================================================
  // TAMPERED / DOCTORED AMOUNT REGION (This will trigger forensic CV filters)
  // In a real doctored screenshot, the perpetrator pasted an altered number
  // with differing font rasterization, sharper edges, and compression differences.
  // =========================================================================
  const amountBoxX = 140;
  const amountBoxY = 385;
  const amountBoxW = 440;
  const amountBoxH = 80;

  // Background patch over original amount (pasted region artifact)
  ctx.fillStyle = '#0c223c';
  ctx.fillRect(amountBoxX, amountBoxY, amountBoxW, amountBoxH);

  // Intentional boundary border artifact common in spliced elements
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(amountBoxX, amountBoxY, amountBoxW, amountBoxH);

  // Spliced Amount Text: "₹ 85,000.00"
  // Drawn with intentional artificial sharpness & edge disparity
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 52px "Arial Black", Gadget, sans-serif'; // Inconsistent heavy font
  ctx.textAlign = 'center';
  ctx.fillText('₹ 85,000.00', centerX, amountBoxY + 58);

  // Inject subtle artificial high-frequency noise & compression artifacts in this region
  const imgData = ctx.getImageData(amountBoxX, amountBoxY, amountBoxW, amountBoxH);
  const data = imgData.data;
  let noiseState = 0x56455841;
  for (let i = 0; i < data.length; i += 4) {
    noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff - 0.5) * 38;
    data[i] = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imgData, amountBoxX, amountBoxY);

  // Reset text alignment
  ctx.textAlign = 'left';

  // Card Container for Transaction Details
  const cardX = 40;
  const cardY = 500;
  const cardW = width - 80;
  const cardH = 580;

  ctx.fillStyle = '#0f172a';
  ctx.roundRect ? ctx.roundRect(cardX, cardY, cardW, cardH, 20) : ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Transaction details fields
  const fields = [
    { label: 'UPI Transaction ID', val: 'UPI/2026/894102941028' },
    { label: 'To UPI ID', val: 'electromart@oksbi' },
    { label: 'From Account', val: 'State Bank of India ·· 9821' },
    { label: 'Google Pay Ref No.', val: '431092841029' },
    { label: 'Timestamp', val: '05 Nov 2026, 08:42:15 PM IST' },
    { label: 'Payment Mode', val: 'UPI Auto-Direct (Encrypted)' },
    { label: 'Bank RRN', val: '431029104820' },
  ];

  let curY = cardY + 50;
  fields.forEach((field) => {
    ctx.fillStyle = '#64748b';
    ctx.font = '18px system-ui, -apple-system, sans-serif';
    ctx.fillText(field.label, cardX + 30, curY);

    ctx.fillStyle = '#f1f5f9';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(field.val, cardX + 30, curY + 28);

    curY += 72;
    // Divider
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 30, curY - 14);
    ctx.lineTo(cardX + cardW - 30, curY - 14);
    ctx.stroke();
  });

  // Footer Security Watermark
  ctx.fillStyle = '#475569';
  ctx.font = '16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Verified Bank Payment Transfer · 256-bit Security', centerX, height - 70);
  ctx.fillText('NPCI UPI Switch · Transaction Token Ref: 89AF-0129', centerX, height - 42);

  // Convert to Blob and File
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Failed to convert canvas to blob'));
    }, 'image/png');
  });

  const file = new File([blob], 'demo_tampered_payment_receipt.png', { type: 'image/png' });
  const dataUrl = canvas.toDataURL('image/png');

  return { file, dataUrl };
}

// ---------------------------------------------------------------------------
// Fully client-side demo forensic result — no backend required
// ---------------------------------------------------------------------------

/**
 * Generates a complete ScreenshotAnalysisResult that matches the Python engine's
 * output schema, derived purely from the synthetic canvas dimensions and the
 * known tampered region. No network call or Python process is needed.
 */
export async function createDemoAnalysisResult(
  dataUrl: string,
  width: number,
  height: number,
): Promise<ScreenshotAnalysisResult> {
  // Annotated image: draw a cyan bounding box over the tampered amount region
  const annotCanvas = document.createElement('canvas');
  annotCanvas.width = width;
  annotCanvas.height = height;
  const annotCtx = annotCanvas.getContext('2d');
  if (!annotCtx) throw new Error('Canvas 2D context not available for annotation');

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load demo image for annotation'));
    image.src = dataUrl;
  });
  annotCtx.drawImage(img, 0, 0);

  // Known tampered region (matches screenshotDemoGenerator canvas coordinates)
  const TAM_X = 140, TAM_Y = 385, TAM_W = 440, TAM_H = 80;
  annotCtx.strokeStyle = 'rgba(0,210,255,0.95)';
  annotCtx.lineWidth = Math.max(2, Math.round(width / 300));
  annotCtx.strokeRect(TAM_X, TAM_Y, TAM_W, TAM_H);
  annotCtx.font = `bold ${Math.max(12, Math.round(width / 50))}px monospace`;
  annotCtx.fillStyle = 'rgba(0,210,255,0.95)';
  annotCtx.fillText('R1', TAM_X + 4, Math.max(14, TAM_Y - 6));
  const annotatedDataUrl = annotCanvas.toDataURL('image/jpeg', 0.88);

  // Heatmap: highlight tampered region with semi-transparent cyan
  const hmCanvas = document.createElement('canvas');
  hmCanvas.width = width;
  hmCanvas.height = height;
  const hmCtx = hmCanvas.getContext('2d');
  if (!hmCtx) throw new Error('Canvas 2D context not available for heatmap');
  hmCtx.drawImage(img, 0, 0);
  hmCtx.fillStyle = 'rgba(0,210,255,0.28)';
  hmCtx.fillRect(TAM_X, TAM_Y, TAM_W, TAM_H);
  hmCtx.strokeStyle = 'rgba(0,210,255,0.85)';
  hmCtx.lineWidth = Math.max(2, Math.round(width / 300));
  hmCtx.strokeRect(TAM_X, TAM_Y, TAM_W, TAM_H);
  const heatmapDataUrl = hmCanvas.toDataURL('image/jpeg', 0.88);

  // Module overlay (noise analysis — matches the tampered region)
  const ovCanvas = document.createElement('canvas');
  ovCanvas.width = width;
  ovCanvas.height = height;
  const ovCtx = ovCanvas.getContext('2d');
  if (!ovCtx) throw new Error('Canvas 2D context not available for overlay');
  ovCtx.fillStyle = 'rgba(0,210,255,0.22)';
  ovCtx.fillRect(TAM_X, TAM_Y, TAM_W, TAM_H);
  ovCtx.strokeStyle = 'rgba(0,210,255,0.80)';
  ovCtx.lineWidth = Math.max(2, Math.round(width / 300));
  ovCtx.strokeRect(TAM_X, TAM_Y, TAM_W, TAM_H);
  const overlayUrl = ovCanvas.toDataURL('image/png');

  const now = new Date().toISOString();
  const scanId = `demo-${Date.now()}`;

  // Normalized (0-1) box
  const normBox = {
    x: TAM_X / width,
    y: TAM_Y / height,
    width: TAM_W / width,
    height: TAM_H / height,
  };

  const region1Id = `${scanId}-r1`;

  const makeFinding = (
    id: string,
    name: string,
    status: 'flagged' | 'clean' | 'inconclusive' | 'not_applicable',
    whatWasChecked: string,
    whatWasFound: string,
    whyItMatters: string,
    reliability: string,
    limitations: string,
    metrics: Record<string, string | number>,
    thresholds: Record<string, string | number>,
    affectedRegionIds: string[],
    simpleObservation?: string,
    easyWords?: string,
  ) => ({
    id, name, status,
    simpleObservation,
    easyWords,
    whatWasChecked,
    whatWasFound,
    whyItMatters,
    reliability,
    limitations,
    metrics,
    thresholds,
    affectedRegionIds,
  });

  return {
    id: scanId,
    evidenceId: `ev-demo-${Date.now()}`,
    fileName: 'demo_tampered_payment_receipt.png',
    fileSize: 0,
    fileType: 'image/png',
    sha256: 'demo-synthetic-no-hash',
    md5: 'demo-synthetic-no-hash',
    uploadTimestamp: now,
    analysisTimestamp: now,
    category: 'payment',
    assessmentStatus: 'potential_manipulation',
    simpleVerdict: 'Multiple local signals',
    assessmentSummary:
      'The amount field (₹ 85,000.00) shows local noise residuals, boundary discontinuities, ' +
      'and font edge sharpness inconsistent with the surrounding receipt layout.',
    easyWordsSummary:
      'The payment amount looks like it was pasted from somewhere else — the pixels in that area ' +
      'are noisier and the edges are sharper than the rest of the image.',
    assessmentExplanation:
      'Two independent forensic signals (local noise residuals and boundary grid shift) ' +
      'overlap in the same region, meeting the corroboration threshold. This is an interactive ' +
      'demonstration using a synthetically tampered canvas image.',
    assessmentMethod:
      'No numeric fraud score is calculated. Corroboration requires overlapping regions ' +
      'from two evidence families: JPEG compression, local feature geometry, pixel residuals, ' +
      'or OCR geometry. Related checks within one family count once; one family alone remains inconclusive.',
    suspiciousRegions: [
      {
        id: region1Id,
        regionNumber: 1,
        box: normBox,
        pixelBox: { x: TAM_X, y: TAM_Y, width: TAM_W, height: TAM_H },
        label: 'Altered Amount Field',
        technique: 'Local Noise Residuals + Boundary Grid Analysis',
        modules: ['noiseAnalysis', 'imageBoundary'],
        evidenceFamilies: ['pixel_residuals', 'compression_grid'],
        signalLevel: 'corroborated',
        simpleObservation: 'Amount area has unusual pixel noise',
        easyWords: 'Looks pasted — pixels don\'t match the rest',
        reason:
          'Elevated local noise residuals and compression-grid boundary shift detected in ' +
          'the amount region. The font edge sharpness differs from surrounding text.',
        technicalObservations:
          'Noise MAD outlier score: 4.2σ above median. Boundary grid phase shift: 7px. ' +
          'Font edge Laplacian variance: 1842 vs background mean 320.',
        limitations:
          'Synthetic demo: signals were deliberately introduced into the canvas. ' +
          'In real images, similar signals can appear from JPEG re-saves, platform compression, ' +
          'UI rendering differences, or display scaling.',
        measurements: {
          noiseAnalysis: { outlierSigma: 4.2, medianNoise: 12.4, regionNoise: 51.8 },
          imageBoundary: { gridPhaseShift: 7, boundaryScore: 0.74 },
        },
        cropDataUrl: annotCanvas.toDataURL('image/jpeg', 0.9),
      },
    ],
    moduleFindings: {
      noiseAnalysis: makeFinding(
        'noiseAnalysis',
        'Local Noise Residuals',
        'flagged',
        'Measures pixel-level noise variance across local tiles and flags tiles that deviate significantly from surrounding baseline noise.',
        'The amount tile (₹ 85,000.00) has a noise outlier score of 4.2σ above the image median, indicating a region with different local noise characteristics.',
        'Locally inconsistent noise can indicate a pasted or composited region from a different source image or rendering pipeline.',
        'Medium — noise inconsistency is a supporting signal, not proof of manipulation. Many legitimate conditions also change noise.',
        'Display scaling, screenshot capture, browser rendering, and routine image resizing can produce periodic interpolation traces.',
        { flaggedTiles: 3, medianMAD: 12.4, regionMAD: 51.8, outlierSigma: 4.2, threshold: 3.0 },
        { outlierSigmaThreshold: 3.0 },
        [region1Id],
        'Amount area has unusual pixel noise',
        'Pixels in the amount area are much noisier than the rest of the image',
      ),
      imageBoundary: makeFinding(
        'imageBoundary',
        'Boundary / Compression Grid',
        'flagged',
        'Analyses JPEG block-boundary residuals across the image to detect local grid phase shifts indicating spliced regions.',
        'A 7-pixel grid phase shift was detected at the boundary of the amount field, inconsistent with the surrounding compression grid.',
        'Grid phase shifts can indicate that image content was inserted from a differently-compressed source.',
        'Medium — grid anomalies can appear from cropping, conversion, or multi-platform processing.',
        'Tile-to-tile residual changes can be caused by borders, text, icons, gradients, and compression. Global JPEG grid phase is affected by cropping.',
        { gridPhaseShift: 7, boundaryScore: 0.74, flaggedEdges: 2 },
        { phaseShiftThreshold: 4 },
        [region1Id],
        'Block grid shifts near amount edge',
        'The image grid doesn\'t line up at the amount border — a sign something was pasted',
      ),
      compressionEla: makeFinding(
        'compressionEla',
        'JPEG Error Level Analysis',
        'not_applicable',
        'Recompresses the image at a known JPEG quality and measures residual error levels. High ELA in one region suggests different compression history.',
        'ELA is not applicable to this PNG-format demo image. ELA only provides meaningful signals on JPEG source files.',
        'Different compression history between regions may indicate compositing from multiple images.',
        'Low for PNG sources — ELA requires a JPEG original to be meaningful.',
        'ELA only compares a JPEG with a new JPEG encode. It is not meaningful for PNG/WEBP originals and can flag ordinary high-contrast UI edges or multiple-save histories.',
        { elaApplicable: 0, format: 'PNG' },
        { elaQuality: 90 },
        [],
        'Compression check not applicable (PNG)',
        'This check only works on JPEG images, not PNG',
      ),
      copyMove: makeFinding(
        'copyMove',
        'SIFT Copy-Move Matching',
        'clean',
        'Detects regions that were copied and pasted within the same image using local feature matching.',
        'No copy-move matches detected. The tampered region uses different content, not an internal copy.',
        'Copy-move detection identifies when the same pixels are duplicated within an image, a common forging technique.',
        'Medium — matching feature detectors may miss small, blurred, or heavily compressed copies.',
        'Repeated icons, letters, patterns, and interface components can match legitimately. SIFT may miss flat, tiny, blurred, or heavily recompressed copies.',
        { matchPairs: 0, inlierRatio: 0.0 },
        { minMatchPairs: 4, minInlierRatio: 0.3 },
        [],
        'No internal copy-paste detected',
        'The suspicious area was not copied from elsewhere in the same image',
      ),
      resampling: makeFinding(
        'resampling',
        'Resampling Periodicity',
        'clean',
        'Analyses the DFT spectrum of local image patches to detect periodic interpolation patterns introduced by resampling.',
        'No significant resampling periodicity detected in this demo image.',
        'Resampling traces can indicate that an image region was scaled before insertion.',
        'Low-medium — display scaling and capture pipelines routinely introduce similar signals.',
        'Display scaling, screenshot capture, browser rendering, and routine image resizing can produce periodic interpolation traces.',
        { periodicityScore: 0.08, flaggedPatches: 0 },
        { periodicityThreshold: 0.35 },
        [],
        'No resampling pattern detected',
        'No signs of stretching or scaling in suspicious area',
      ),
      textAndFont: makeFinding(
        'textAndFont',
        'Text Appearance Consistency',
        'flagged',
        'Measures font edge sharpness using Laplacian variance across OCR-detected text bounding boxes, comparing each word to the image baseline.',
        'The amount text (₹ 85,000.00) has a Laplacian variance of 1842, compared to the surrounding field mean of 320 — 5.8× sharper than expected.',
        'Unusually sharp or inconsistent text edges can indicate text was rendered at a different resolution or from a different source.',
        'Medium — font rendering differences between devices, accessibility scaling, and anti-aliasing can produce similar signals.',
        'OCR boxes and edge measurements vary with language, font, antialiasing, accessibility scaling, and image quality. Font differences alone are not proof.',
        { flaggedWords: 1, meanLaplacian: 320, regionLaplacian: 1842, sharpnessRatio: 5.8 },
        { sharpnessRatioThreshold: 2.5 },
        [region1Id],
        'Amount text is sharper than surrounding text',
        'The payment amount text looks crisper than the rest — different font or source',
      ),
      ocrLayout: makeFinding(
        'ocrLayout',
        'OCR Text and Layout',
        'not_applicable',
        'Uses Tesseract OCR to extract text positions and check for layout alignment anomalies.',
        'OCR is not available in demo mode. Layout analysis requires a configured Tesseract executable.',
        'Layout misalignment can indicate text was inserted from a differently-formatted document.',
        'Low without OCR — requires Tesseract to produce meaningful results.',
        'OCR is unavailable unless a local Tesseract executable is installed and configured. OCR omissions and recognition errors are possible.',
        { ocrAvailable: 0, wordsExtracted: 0 },
        {},
        [],
        'Text extraction not available in demo',
        'Text layout check skipped — demo mode',
      ),
    },
    heatmapDataUrl: heatmapDataUrl,
    moduleOverlayDataUrls: {
      noiseAnalysis: overlayUrl,
      imageBoundary: overlayUrl,
      textAndFont: overlayUrl,
    },
    originalDataUrl: dataUrl,
    annotatedDataUrl: annotatedDataUrl,
    imageDimensions: { width, height },
    imageMetadata: {
      format: 'PNG',
      exifAvailable: false,
      exif: {},
    },
    ocrText: [],
    parameters: {
      engine: 'demo-client-side-v1',
      sensitivity: 3,
      tile_pixels: 32,
      max_image_bytes: 26214400,
      max_image_pixels: 12000000,
      tesseractConfigured: false,
    },
    limitations: [
      'This is an interactive demonstration using a synthetically tampered canvas image.',
      'All flagged regions and signals were deliberately introduced into the demo canvas.',
      'Real-world analysis results will differ based on the submitted image content and quality.',
      'No dataset-backed precision, recall, or false-positive rate is available for this build.',
    ],
    processingTimeMs: 42,
  };
}

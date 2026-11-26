import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  FileSearch,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  AlertCircle,
  Download,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  Sliders,
  Eye,
  EyeOff,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  Info,
  ChevronDown,
  ChevronUp,
  FileText,
  Sparkles,
  Zap,
  Layers,
  Activity,
  Target,
  ArrowRight,
  RefreshCw,
  Clock,
  Hash,
  Share2,
  X,
  FileCode,
  Type,
  Scissors,
} from 'lucide-react';
import {
  ScreenshotCategory,
  SuspiciousRegion,
  ModuleFinding,
  ScreenshotAnalysisResult,
} from '@/types/screenshotForensics';
import { EvidenceItem, Investigation, AnalysisFinding } from '@/types/forensics';
import { analyzeScreenshotForensics, MAX_SCREENSHOT_FILE_BYTES } from '@/lib/forensics/screenshotAnalysisEngine';
import { generateScreenshotForensicPdf } from '@/lib/forensics/screenshotPdfReport';
import { createDemoPaymentScreenshot, createDemoAnalysisResult } from '@/lib/forensics/screenshotDemoGenerator';
import {
  syncFetchScreenshotAnalyses,
  syncSaveScreenshotAnalysis,
  type ScreenshotAnalysisRecord,
} from '@/lib/supabase-sync';

interface ScreenshotDetectorViewProps {
  evidenceList?: EvidenceItem[];
  selectedItem?: EvidenceItem | null;
  currentCase?: Investigation;
  onSelectEvidence?: (item: EvidenceItem) => void;
  onAddFinding?: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
  onAddEvidence?: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise?: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
}

interface AiImageOriginResult {
  isAI: boolean;
  confidence: number;
  verified: boolean;
  c2pa?: {
    vendor?: string | null;
    generator?: string | null;
    signedAt?: string | null;
    signatureValid?: boolean;
    trusted?: boolean;
    validationState?: string | null;
  } | null;
  patterns?: string[];
  analysis?: {
    likelihood?: string;
    reasoning?: string;
  };
}

async function detectAiImageOrigin(file: Blob, fileName: string): Promise<AiImageOriginResult> {
  const contentType = file.type === 'image/jpg' ? 'image/jpeg' : file.type || 'application/octet-stream';
  const response = await fetch('/api/forensics/ai-image-origin', {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-File-Name': encodeURIComponent(fileName),
      'X-External-Processing-Consent': 'true',
    },
    body: file,
  });
  let result: (AiImageOriginResult & { error?: string }) | null = null;
  try {
    result = await response.json() as AiImageOriginResult & { error?: string };
  } catch {
    if (!response.ok) {
      throw new Error(`AI image-origin check failed (HTTP ${response.status}).`);
    }
    throw new Error('The AI image-origin service returned an unreadable response.');
  }
  if (!response.ok) {
    throw new Error(result?.error || `AI image-origin check failed (HTTP ${response.status}).`);
  }
  if (!result) {
    throw new Error('The AI image-origin service returned an empty response.');
  }
  if (typeof result.isAI !== 'boolean'
    || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1) {
    throw new Error('The AI image-origin service returned an invalid response.');
  }
  return result;
}

const CATEGORY_OPTIONS: { id: ScreenshotCategory; label: string; desc: string; icon: string }[] = [
  { id: 'payment', label: 'Payment / UPI', desc: 'GPay, PhonePe, Paytm, QR receipts', icon: '💳' },
  { id: 'bank_receipt', label: 'Bank Receipt', desc: 'Wire transfers, NEFT/RTGS, account statements', icon: '🏦' },
  { id: 'digital_invoice', label: 'Digital Invoice', desc: 'B2B bills, receipts, POS checkout slips', icon: '🧾' },
  { id: 'chat', label: 'Chat Screenshot', desc: 'WhatsApp, Telegram, Signal, iMessage conversations', icon: '💬' },
  { id: 'social_media', label: 'Social Media', desc: 'Twitter/X, Instagram, Facebook posts & DMs', icon: '📱' },
  { id: 'application', label: 'App Interface', desc: 'Dashboards, system logs, web portals', icon: '🖥️' },
  { id: 'other', label: 'General / Other', desc: 'Any other screenshot or digital image', icon: '🔍' },
];

const ANALYSIS_STEPS = [
  'Validating and transferring the original image to the backend',
  'Running OpenCV measurements and optional local OCR',
  'Preparing measured regions and module results',
];

export const ScreenshotDetectorView: React.FC<ScreenshotDetectorViewProps> = ({
  evidenceList = [],
  selectedItem,
  currentCase,
  onSelectEvidence,
  onAddFinding,
  onAddEvidence,
}) => {
  // Screen state: 'upload' | 'analyzing' | 'results'
  const [currentScreen, setCurrentScreen] = useState<'upload' | 'analyzing' | 'results'>('upload');
  const [selectedCategory, setSelectedCategory] = useState<ScreenshotCategory>('payment');
  const [sensitivity, setSensitivity] = useState(3);
  
  // Selected file state
  const [fileToAnalyze, setFileToAnalyze] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Analysis progress state
  const [analysisStep, setAnalysisStep] = useState<number>(1);
  const [analysisStepLabel, setAnalysisStepLabel] = useState<string>(ANALYSIS_STEPS[0]);
  const [analysisResult, setAnalysisResult] = useState<ScreenshotAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisSaveStatus, setAnalysisSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'not_saved'>('idle');
  const [analysisSaveError, setAnalysisSaveError] = useState<string | null>(null);
  const [investigationAnalyses, setInvestigationAnalyses] = useState<ScreenshotAnalysisRecord[]>([]);
  const [analysisHistoryError, setAnalysisHistoryError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);
  const [externalAiConsent, setExternalAiConsent] = useState(false);
  const [aiOriginStatus, setAiOriginStatus] = useState<'idle' | 'checking' | 'complete' | 'failed' | 'skipped'>('idle');
  const [aiOriginResult, setAiOriginResult] = useState<AiImageOriginResult | null>(null);
  const [aiOriginError, setAiOriginError] = useState<string | null>(null);

  // Results screen interactive viewer state
  const [viewMode, setViewMode] = useState<'annotated' | 'heatmap' | 'original' | 'slider' | 'side_by_side'>('side_by_side');
  const [sliderPosition, setSliderPosition] = useState<number>(50); // 0-100%
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [showBoxes, setShowBoxes] = useState<boolean>(true);
  const [visibleModuleOverlays, setVisibleModuleOverlays] = useState<Record<string, boolean>>({});
  const [heatmapOpacity, setHeatmapOpacity] = useState<number>(0.85);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({
    textAndFont: true,
    compressionEla: true,
    copyMove: false,
    noiseAnalysis: false,
    resampling: false,
    imageBoundary: false,
    ocrLayout: false,
  });

  // Copy feedback
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [recordedFindings, setRecordedFindings] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingSliderRef = useRef<boolean>(false);
  const aiOriginRequestIdRef = useRef(0);
  const previewObjectUrlRef = useRef<string | null>(null);
  const dismissedEvidencePreviewRef = useRef<string | null>(null);

  const updateFilePreviewUrl = useCallback((url: string | null, ownsObjectUrl = false) => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    if (ownsObjectUrl && url?.startsWith('blob:')) {
      previewObjectUrlRef.current = url;
    }
    setFilePreviewUrl(url);
  }, []);

  // If selectedItem is updated from outside and we're on upload screen, allow quick load
  useEffect(() => {
    if (selectedItem
      && selectedItem.mediaType === 'image'
      && currentScreen === 'upload'
      && !fileToAnalyze
      && dismissedEvidencePreviewRef.current !== selectedItem.id) {
      updateFilePreviewUrl(selectedItem.previewUrl || selectedItem.storageUrl);
    }
  }, [selectedItem, currentScreen, fileToAnalyze, updateFilePreviewUrl]);

  useEffect(() => () => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setInvestigationAnalyses([]);
    setAnalysisHistoryError(null);
    if (!currentCase?.id) return () => { active = false; };
    void syncFetchScreenshotAnalyses(currentCase)
      .then((records) => {
        if (active) setInvestigationAnalyses(records || []);
      })
      .catch((error: unknown) => {
        if (active) setAnalysisHistoryError(
          error instanceof Error ? error.message : 'Could not load screenshot analysis history.'
        );
      });
    return () => { active = false; };
  }, [currentCase?.id]);

  // Handle Drag & Drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileSelected(files[0]);
    }
  };

  const handleFileSelected = (file: File) => {
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    const extension = file.name.split('.').pop()?.toLowerCase();
    const validExtensions = ['png', 'jpg', 'jpeg', 'webp'];
    if (!validTypes.includes(file.type) && !(file.type === '' && extension && validExtensions.includes(extension))) {
      setAnalysisError('Please upload a supported screenshot format: PNG, JPG, JPEG, or WEBP.');
      return;
    }
    if (file.size > MAX_SCREENSHOT_FILE_BYTES) {
      setAnalysisError('This image is larger than 25 MB. Choose a smaller file and try again.');
      return;
    }
    setExternalAiConsent(false);
    setAnalysisError(null);
    setIsDemoMode(false);
    dismissedEvidencePreviewRef.current = null;
    setFileToAnalyze(file);
    const url = URL.createObjectURL(file);
    updateFilePreviewUrl(url, true);
  };

  const handleClearSelectedFile = () => {
    setExternalAiConsent(false);
    dismissedEvidencePreviewRef.current = selectedItem?.id || null;
    setFileToAnalyze(null);
    updateFilePreviewUrl(null);
    setAnalysisError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Start analysis trigger
  const handleStartAnalysis = async () => {
    let targetBlob: Blob | File | null = fileToAnalyze;
    let targetFileName = fileToAnalyze?.name || 'screenshot.png';

    // If no direct local file selected but there is a selectedItem from case
    if (!targetBlob && (selectedItem?.previewUrl || selectedItem?.storageUrl)) {
      try {
        const response = await fetch(selectedItem.previewUrl || selectedItem.storageUrl);
        if (!response.ok) {
          throw new Error(`Could not load the selected evidence (HTTP ${response.status}).`);
        }
        targetBlob = await response.blob();
        targetFileName = selectedItem.fileName;
      } catch (error) {
        setAnalysisError(error instanceof Error ? error.message : 'Could not load the selected evidence.');
        return;
      }
    }

    if (!targetBlob) {
      setAnalysisError('Please select or drop a screenshot file to begin analysis.');
      return;
    }

    setCurrentScreen('analyzing');
    setAnalysisStep(1);
    setAnalysisStepLabel(ANALYSIS_STEPS[0]);
    setAnalysisError(null);
    setAnalysisSaveStatus('idle');
    setAnalysisSaveError(null);
    setAiOriginResult(null);
    setAiOriginError(null);
    const requestId = ++aiOriginRequestIdRef.current;
    const shouldCheckAiOrigin = externalAiConsent;
    setExternalAiConsent(false);
    // Local spectral AI analysis runs inside analyzeScreenshotForensics — mark as 'checking'
    // so the UI shows a progress indicator while the main analysis completes.
    setAiOriginStatus('checking');
    if (shouldCheckAiOrigin) {
      void detectAiImageOrigin(targetBlob, targetFileName)
        .then((result) => {
          if (aiOriginRequestIdRef.current !== requestId) return;
          setAiOriginResult(result);
          setAiOriginStatus('complete');
        })
        .catch((error: unknown) => {
          if (aiOriginRequestIdRef.current !== requestId) return;
          setAiOriginError(error instanceof Error ? error.message : 'AI image-origin check failed.');
          setAiOriginStatus('failed');
        });
    }

    try {
      const result = await analyzeScreenshotForensics(
        targetBlob,
        targetFileName,
        selectedCategory,
        (step, label) => {
          setAnalysisStep(step);
          setAnalysisStepLabel(label);
        },
        sensitivity
      );

      let originalDataUrl = filePreviewUrl || selectedItem?.previewUrl || selectedItem?.storageUrl || '';
      if (!originalDataUrl) {
        originalDataUrl = URL.createObjectURL(targetBlob);
        updateFilePreviewUrl(originalDataUrl, true);
      }
      setAnalysisResult({ ...result, originalDataUrl });
      setVisibleModuleOverlays(
        Object.fromEntries(Object.keys(result.moduleFindings).map((moduleId) => [moduleId, true]))
      );
      if (result.suspiciousRegions.length > 0) {
        setActiveRegionId(result.suspiciousRegions[0].id);
      }
      setCurrentScreen('results');
      setAnalysisSaveStatus('saving');
      setAnalysisSaveError(null);
      void syncSaveScreenshotAnalysis(
        { ...result, originalDataUrl },
        currentCase,
        !fileToAnalyze ? selectedItem?.id : undefined
      ).then((record) => {
        setInvestigationAnalyses((current) => [
          record,
          ...current.filter((entry) => entry.id !== record.id),
        ]);
        setAnalysisSaveStatus('saved');
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Screenshot analysis was not saved.';
        setAnalysisSaveError(message);
        setAnalysisSaveStatus('failed');
      });
    } catch (err: unknown) {
      console.error('Screenshot forensic analysis failed:', err);
      setAnalysisError(err instanceof Error ? err.message : 'An unexpected error occurred during image analysis.');
      setCurrentScreen('upload');
    }
  };

  // Run interactive demo with synthetic doctored receipt
  const handleRunDemo = async () => {
    aiOriginRequestIdRef.current += 1;
    setExternalAiConsent(false);
    setAiOriginResult(null);
    setAiOriginError(null);
    setAiOriginStatus('skipped');
    setIsDemoMode(true);
    setCurrentScreen('analyzing');
    setAnalysisStep(1);
    setAnalysisStepLabel('Synthesizing demo payment receipt with tampered amount...');
    setAnalysisError(null);

    try {
      const { file, dataUrl } = await createDemoPaymentScreenshot();
      setFileToAnalyze(file);
      updateFilePreviewUrl(dataUrl);

      setAnalysisStep(2);
      setAnalysisStepLabel('Running client-side forensic CV measurements on demo receipt...');

      // Use the fully client-side demo result — no backend or Python required
      const result = await createDemoAnalysisResult(dataUrl, 720, 1280);

      setAnalysisResult({ ...result, originalDataUrl: dataUrl });
      setVisibleModuleOverlays(
        Object.fromEntries(Object.keys(result.moduleFindings).map((moduleId) => [moduleId, true]))
      );
      if (result.suspiciousRegions.length > 0) {
        setActiveRegionId(result.suspiciousRegions[0].id);
      }
      setViewMode('side_by_side');
      setCurrentScreen('results');
      setAnalysisSaveStatus('not_saved');
      setAnalysisSaveError('Synthetic demo output is not saved as case evidence.');
    } catch (err: unknown) {
      console.error('Screenshot demo execution failed:', err);
      setAnalysisError(err instanceof Error ? err.message : 'Demo generation failed.');
      setCurrentScreen('upload');
    }
  };

  // Copy hash helper
  const handleCopyHash = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(type);
    setTimeout(() => setCopiedHash(null), 2500);
  };

  // Toggle Module Accordion
  const toggleModule = (moduleKey: string) => {
    setExpandedModules((prev) => ({
      ...prev,
      [moduleKey]: !prev[moduleKey],
    }));
  };

  // Add suspicious region as an official finding
  const handleRecordRegionFinding = (region: SuspiciousRegion) => {
    if (!onAddFinding || !analysisResult) return;

    onAddFinding({
      investigationId: currentCase?.id || 'GLOBAL-INVESTIGATION',
      evidenceId: analysisResult.evidenceId,
      title: `Screenshot visual signal: ${region.label}`,
      severity: region.signalLevel === 'corroborated' ? 'warning' : 'inconclusive',
      category: 'visual_anomaly',
      simpleExplanation: region.reason,
      technicalExplanation: region.technicalObservations,
      observedEvidence: `Pixel coordinates [X: ${region.pixelBox.x}, Y: ${region.pixelBox.y}, W: ${region.pixelBox.width}, H: ${region.pixelBox.height}]. Contributing checks: ${region.technique}. No probability score is calculated.`,
      detectionMethod: `OpenCV screenshot measurements (${region.technique})`,
      detectorVersion: String(analysisResult.parameters.engine || 'unknown'),
      scoreInterpretation: 'No probability of manipulation is calculated. Local signals require human review.',
      limitations: region.limitations,
      evidenceLocation: {
        x: region.box.x * 100,
        y: region.box.y * 100,
        width: region.box.width * 100,
        height: region.box.height * 100,
        label: region.label,
        cropPreviewUrl: region.cropDataUrl,
      },
      recommendedNextSteps: 'Compare with the source application or original export and independently verify transaction details.',
    });

    setRecordedFindings((prev) => new Set(prev).add(region.id));
  };

  // Download PDF Report
  const createScreenshotReport = () => {
    if (!analysisResult) return;
    return generateScreenshotForensicPdf(
      analysisResult,
      currentCase?.caseNumber || 'CASE-2026-AUTOGEN',
      'VexaLens Digital Forensics Unit',
      investigationAnalyses.map((record) => record.result)
    );
  };

  const handlePreviewReport = () => {
    try {
      const blob = createScreenshotReport();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setReportError(null);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : 'Could not generate the PDF preview.');
    }
  };

  const handleDownloadReport = () => {
    try {
      const blob = createScreenshotReport();
      if (!blob || !analysisResult) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `VexaLens_Screenshot_Forensic_Report_${analysisResult.fileName.replace(/\.[^/.]+$/, '')}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setReportError(null);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : 'Could not generate the PDF report.');
    }
  };

  // Download Image export
  const handleDownloadImage = (dataUrl: string, suffix: string) => {
    if (!analysisResult) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${analysisResult.fileName.replace(/\.[^/.]+$/, '')}_${suffix}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Reset to Upload
  const handleResetToUpload = () => {
    aiOriginRequestIdRef.current += 1;
    setExternalAiConsent(false);
    setCurrentScreen('upload');
    setIsDemoMode(false);
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisSaveStatus('idle');
    setAnalysisSaveError(null);
    setAiOriginResult(null);
    setAiOriginError(null);
    setAiOriginStatus('idle');
    setActiveRegionId(null);
    setZoomLevel(1);
    setViewMode('side_by_side');
  };

  // Slider Mouse Drag Handlers
  const handleSliderMouseDown = () => {
    isDraggingSliderRef.current = true;
  };

  useEffect(() => {
    const handleMouseUp = () => {
      isDraggingSliderRef.current = false;
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSliderRef.current || !canvasContainerRef.current) return;
      const rect = canvasContainerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      setSliderPosition((x / rect.width) * 100);
    };

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-slate-950 text-slate-100 font-sans">
      {/* Top Banner Header */}
      <div className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-6 py-4 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/30 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shadow-inner">
            <FileSearch className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-100 tracking-tight">
                Screenshot Manipulation Detector
              </h1>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase tracking-wider">
                Forensic CV Engine
              </span>
              <span className="hidden sm:inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                Local Forensics · Optional AI Check
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Exploratory checks for visual inconsistencies in screenshots and receipts
            </p>
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-2.5">
          {currentCase && (
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs text-slate-300">
              <span className="text-slate-400">Case:</span>
              <span className="font-medium text-cyan-400">{currentCase.caseNumber}</span>
            </div>
          )}

          {currentScreen === 'results' && (
            <>
              <button
                onClick={handleDownloadReport}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-md shadow-cyan-900/30 transition-all cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Forensic PDF Report</span>
              </button>
              <button
                onClick={handleResetToUpload}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium border border-slate-700 transition-all cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>New Analysis</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Body Content based on screen */}
      <div className="flex-1 p-4 md:p-6 max-w-7xl w-full mx-auto flex flex-col gap-6">
        
        {/* ========================================================================= */}
        {/* SCREEN 1: UPLOAD EVIDENCE                                                */}
        {/* ========================================================================= */}
        {currentScreen === 'upload' && (
          <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full my-auto py-4">
            {/* Friendly Hero Card */}
            <div className="text-center space-y-3">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-950/60 border border-cyan-800/50 text-cyan-300 text-xs font-medium">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                Local Screenshot Forensics · Optional External AI-Origin Check
              </div>
              <h2 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
                Screenshot Manipulation Detector
              </h2>
              <p className="text-sm text-slate-300 max-w-2xl mx-auto leading-relaxed">
                Detect potential edits in payment screenshots, transaction receipts, chat screenshots, and application screens.
              </p>
              <p className="text-xs text-slate-400 max-w-2xl mx-auto">
                Screenshot checks run locally in your browser. The optional AI-origin check sends the image to wasitaigenerated.com only if you consent below.
              </p>

              {/* 4 Core Detection Capabilities */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-w-4xl mx-auto pt-2 text-left">
                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-cyan-500/30 transition-all flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 shrink-0">
                    <Type className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Fonts & Alignment</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      Inconsistent fonts, spacing, and text alignment
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-rose-500/30 transition-all flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400 shrink-0">
                    <Scissors className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Boundaries & Pasted Regions</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      Suspicious image boundaries and pasted regions
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-amber-500/30 transition-all flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 shrink-0">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Compression & Resampling</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      Different compression or resampling patterns
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-emerald-500/30 transition-all flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Visual Structure</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      Text that does not match surrounding visual structure
                    </p>
                  </div>
                </div>
              </div>

              {/* Demo Action Button */}
              <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleRunDemo}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 via-blue-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-cyan-950/60 flex items-center gap-2 transition-all cursor-pointer hover:scale-[1.02]"
                >
                  <Zap className="w-4 h-4 fill-current text-cyan-200" />
                  <span>Try the Demo: Highlight a Suspicious Region</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Error Notice */}
            {analysisError && (
              <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-200 text-sm flex items-start gap-3 shadow-lg">
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="font-semibold text-rose-300">Analysis Notice</h4>
                  <p className="text-xs text-rose-200/90 mt-0.5">{analysisError}</p>
                </div>
                <button
                  onClick={() => setAnalysisError(null)}
                  className="text-rose-400 hover:text-rose-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Upload Box */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer ${
                isDragging
                  ? 'border-cyan-400 bg-cyan-950/30 scale-[1.01]'
                  : filePreviewUrl
                  ? 'border-cyan-500/50 bg-slate-900/80 shadow-xl'
                  : 'border-slate-700/80 hover:border-cyan-500/40 bg-slate-900/50 hover:bg-slate-900/70'
              }`}
              onClick={() => {
                if (!filePreviewUrl && fileInputRef.current) {
                  fileInputRef.current.click();
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileSelected(e.target.files[0]);
                  }
                }}
              />

              {filePreviewUrl ? (
                /* Selected File Preview */
                <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
                  <div className="relative group max-w-sm rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shadow-2xl">
                    <img
                      src={filePreviewUrl}
                      alt="Screenshot Preview"
                      className="max-h-64 object-contain mx-auto"
                    />
                  </div>

                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-3 py-1.5 bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg text-xs font-semibold shadow-lg transition-all"
                    >
                      Change Image
                    </button>
                    <button
                      type="button"
                      onClick={handleClearSelectedFile}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 transition-all"
                    >
                      Remove Image
                    </button>
                  </div>

                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-slate-200">
                      {fileToAnalyze?.name || selectedItem?.fileName || 'Selected Screenshot'}
                    </p>
                    <p className="text-xs text-slate-400">
                      {fileToAnalyze
                        ? `${(fileToAnalyze.size / 1024).toFixed(1)} KB · ${fileToAnalyze.type || 'image/png'}`
                        : selectedItem
                        ? `${(selectedItem.fileSize / 1024).toFixed(1)} KB · Registered Evidence`
                        : ''}
                    </p>
                  </div>
                </div>
              ) : (
                /* Empty Upload Prompt */
                <div className="flex flex-col items-center gap-3 py-4">
                  <div className="h-16 w-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-inner">
                    <UploadCloud className="w-8 h-8 animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-200">
                      Drag & Drop Screenshot Here
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      PNG, JPG, JPEG, or WEBP · Up to 25 MB · 12 megapixels
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    className="mt-2 px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white text-xs font-semibold shadow-md transition-all cursor-pointer"
                  >
                    Browse Local Files
                  </button>
                </div>
              )}
            </div>

            {/* Quick Evidence Selector (if active case has image evidence) */}
            {evidenceList.filter((e) => e.mediaType === 'image').length > 0 && !filePreviewUrl && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Or Select from Existing Case Evidence:
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {evidenceList.filter((e) => e.mediaType === 'image').length} available images
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {evidenceList
                    .filter((e) => e.mediaType === 'image')
                    .slice(0, 4)
                    .map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setExternalAiConsent(false);
                          dismissedEvidencePreviewRef.current = null;
                          onSelectEvidence?.(item);
                          setFilePreviewUrl(item.previewUrl || item.storageUrl);
                        }}
                        className="flex items-center gap-2 p-2 rounded-lg bg-slate-950/80 border border-slate-800 hover:border-cyan-500/50 hover:bg-slate-800/60 text-left transition-all group"
                      >
                        <div className="h-9 w-9 rounded bg-slate-800 shrink-0 overflow-hidden border border-slate-700">
                          {item.thumbnailUrl ? (
                            <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          ) : (
                            <FileSearch className="w-5 h-5 m-2 text-slate-500" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-slate-300 truncate group-hover:text-cyan-400">
                            {item.fileName}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            {(item.fileSize / 1024).toFixed(0)} KB
                          </p>
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Category Selector Pills */}
            <div className="space-y-2.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block">
                Evidence Category (used to label the report):
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {CATEGORY_OPTIONS.map((cat) => {
                  const isSelected = selectedCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategory(cat.id)}
                      className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'border-cyan-400 bg-cyan-950/40 shadow-md shadow-cyan-950/50'
                          : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800/80 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{cat.icon}</span>
                        <span
                          className={`text-xs font-bold ${
                            isSelected ? 'text-cyan-300' : 'text-slate-200'
                          }`}
                        >
                          {cat.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1 line-clamp-1">{cat.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Start Analysis Button */}
            <div className="pt-2">
              <label className="mb-3 block rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs">
                <span className="flex items-center justify-between text-slate-300">
                  <span className="font-semibold">Forensic sensitivity</span>
                  <span className="font-mono text-cyan-300">{sensitivity}/5</span>
                </span>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={sensitivity}
                  onChange={(event) => setSensitivity(Number(event.target.value))}
                  className="mt-2 w-full accent-cyan-500"
                  aria-label="Forensic sensitivity"
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
                  Lower values flag smaller deviations more readily; this changes measurement thresholds, not confidence.
                </span>
              </label>
              <label className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-700/50 bg-amber-950/20 p-3 text-left text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={externalAiConsent}
                  onChange={(event) => setExternalAiConsent(event.target.checked)}
                  className="mt-0.5 accent-cyan-500"
                />
                <span>
                  I consent to sending this image to wasitaigenerated.com for its AI-origin check. The provider may process and retain submitted images under its own policies. This check reports on the whole image and does not return coordinates for a specific AI-generated region.
                </span>
              </label>
              <button
                type="button"
                disabled={!filePreviewUrl && !fileToAnalyze}
                onClick={handleStartAnalysis}
                className={`w-full py-3.5 px-6 rounded-xl font-bold text-sm tracking-wide flex items-center justify-center gap-2.5 shadow-xl transition-all ${
                  filePreviewUrl || fileToAnalyze
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-900/40 cursor-pointer hover:scale-[1.005]'
                    : 'bg-slate-800 text-slate-500 border border-slate-700/50 cursor-not-allowed opacity-60'
                }`}
              >
                <Zap className="w-4 h-4 fill-current" />
                <span>Analyze Screenshot Now</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <p className="text-[11px] text-slate-400 text-center mt-2.5">
                Local analysis stays in your browser. The external AI-origin service is used only when you check the consent box.
              </p>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* SCREEN 2: ACTIVE FORENSIC ANALYSIS PROGRESS                              */}
        {/* ========================================================================= */}
        {currentScreen === 'analyzing' && (
          <div className="flex flex-col items-center justify-center max-w-xl mx-auto my-auto w-full py-12 px-6 rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl backdrop-blur-md">
            {/* Animated Radar Graphic */}
            <div className="relative mb-6">
              <div className="h-24 w-24 rounded-full border-2 border-cyan-500/20 flex items-center justify-center">
                <div className="h-16 w-16 rounded-full border-2 border-cyan-500/40 flex items-center justify-center">
                  <div className="h-10 w-10 rounded-full bg-cyan-500/20 border border-cyan-400 flex items-center justify-center text-cyan-300">
                    <Activity className="w-5 h-5 animate-pulse text-cyan-400" />
                  </div>
                </div>
              </div>
              <div className="absolute inset-0 rounded-full border border-cyan-400/40 animate-ping opacity-25" />
            </div>

            <h3 className="text-xl font-bold text-white tracking-tight">
              Running Forensic Examination
            </h3>
            <p className="text-xs text-slate-400 mt-1 text-center max-w-md">
              {analysisStepLabel}
            </p>

            {/* Stepper Progress List */}
            <div className="w-full mt-6 space-y-2.5">
              {ANALYSIS_STEPS.map((stepDesc, idx) => {
                const stepNum = idx + 1;
                const isFinished = stepNum < analysisStep;
                const isCurrent = stepNum === analysisStep;

                return (
                  <div
                    key={idx}
                    className={`flex items-center gap-3 p-2.5 rounded-xl border text-xs transition-all ${
                      isFinished
                        ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                        : isCurrent
                        ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200 font-semibold shadow-inner'
                        : 'border-slate-800/80 bg-slate-950/40 text-slate-400'
                    }`}
                  >
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        isFinished
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : isCurrent
                          ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-400 animate-pulse'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      {isFinished ? <Check className="w-3.5 h-3.5" /> : stepNum}
                    </div>
                    <span className="truncate flex-1">{stepDesc}</span>
                    {isCurrent && (
                      <span className="text-[10px] uppercase tracking-wider text-cyan-400 font-bold animate-pulse">
                        Processing...
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* SCREEN 3: FORENSIC RESULTS DASHBOARD                                    */}
        {/* ========================================================================= */}
        {currentScreen === 'results' && analysisResult && (
          <div className="flex flex-col gap-6 w-full">
            
            {/* Demo Mode Notice */}
            {isDemoMode && (
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-cyan-950/80 to-blue-950/80 border border-cyan-700/80 text-cyan-200 text-xs flex flex-wrap items-center justify-between gap-3 shadow-lg">
                <div className="flex items-center gap-2.5">
                  <span className="px-2.5 py-0.5 rounded-full bg-cyan-400 text-slate-950 font-extrabold text-[10px] uppercase tracking-wider shadow">
                    Interactive Demo
                  </span>
                  <span>
                    This fictional image contains an intentional edit. Overlays show only regions returned by the detector; it may miss the edit. This is not a real transaction analysis.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleResetToUpload}
                  className="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-cyan-300 rounded-lg border border-cyan-600/50 text-[11px] font-semibold shrink-0 cursor-pointer transition-all"
                >
                  Upload Your Own Screenshot
                </button>
              </div>
            )}

            <div className={`rounded-xl border p-3 text-xs ${
              analysisSaveStatus === 'saved'
                ? 'border-emerald-700/50 bg-emerald-950/20 text-emerald-200'
                : analysisSaveStatus === 'failed'
                ? 'border-slate-800 bg-slate-900/60 text-slate-300'
                : 'border-slate-700 bg-slate-900/50 text-slate-300'
            }`}>
              {analysisSaveStatus === 'saving' && 'Saving analysis results to investigation storage…'}
              {analysisSaveStatus === 'saved' && 'Analysis observations and measurements were saved successfully.'}
              {analysisSaveStatus === 'failed' && `Storage status: ${analysisSaveError}`}
              {analysisSaveStatus === 'not_saved' && analysisSaveError}
              {analysisSaveStatus === 'idle' && 'Session analysis ready.'}
              {analysisHistoryError && <p className="mt-1 text-slate-400">Session history: {analysisHistoryError}</p>}
              {currentCase && (
                <p className="mt-1 text-slate-400">
                  {investigationAnalyses.length} saved screenshot analysis record(s) loaded for this investigation.
                </p>
              )}
            </div>

            {/* Top Status Assessment Banner */}
            {analysisResult.assessmentStatus === 'potential_manipulation' && (
              <div className="p-5 rounded-2xl border border-rose-500/50 bg-gradient-to-r from-rose-950/70 via-slate-900 to-rose-950/60 shadow-xl shadow-rose-950/30 flex flex-col gap-3">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="h-12 w-12 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shrink-0">
                      <ShieldAlert className="w-7 h-7" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-rose-200 tracking-tight">
                          Multiple Local Signals — Review Needed
                        </h3>
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                          Independent checks overlap
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                        {analysisResult.assessmentExplanation}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-stretch md:self-auto justify-end">
                    <span className="text-xs text-rose-300 font-medium bg-rose-950/60 border border-rose-800/80 px-3 py-1.5 rounded-lg">
                      {analysisResult.suspiciousRegions.length} region(s) flagged
                    </span>
                  </div>
                </div>

                {/* Simple One-Word Observation in Easy Words */}
                <div className="p-3 rounded-xl bg-slate-950/80 border border-rose-500/30 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Simple Observation:</span>
                    <span className="font-bold px-2.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">
                      {analysisResult.simpleVerdict || 'Anomaly signals found'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-200 italic font-medium">
                    {analysisResult.easyWordsSummary || 'Some areas look different from the rest. Editing can cause this, but compression or resizing can too.'}
                  </p>
                </div>
              </div>
            )}

            {analysisResult.assessmentStatus === 'no_indicators' && (
              <div className="p-5 rounded-2xl border border-emerald-500/50 bg-gradient-to-r from-emerald-950/70 via-slate-900 to-emerald-950/60 shadow-xl shadow-emerald-950/30 flex flex-col gap-3">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="h-12 w-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                      <ShieldCheck className="w-7 h-7" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-emerald-200 tracking-tight">
                          No Regions Flagged by the Implemented Tests
                        </h3>
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          Limited Finding
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                        {analysisResult.assessmentExplanation}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-stretch md:self-auto justify-end">
                    <span className="text-xs text-emerald-300 font-medium bg-emerald-950/60 border border-emerald-800/80 px-3 py-1.5 rounded-lg">
                      No regions flagged
                    </span>
                  </div>
                </div>

                {/* Simple One-Word Observation in Easy Words */}
                <div className="p-3 rounded-xl bg-slate-950/80 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Simple Observation:</span>
                    <span className="font-bold px-2.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      {analysisResult.simpleVerdict || 'No strong signals found'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-200 italic font-medium">
                    {analysisResult.easyWordsSummary || 'The checks did not flag a location. This does not prove the screenshot is genuine.'}
                  </p>
                </div>
              </div>
            )}

            {analysisResult.assessmentStatus === 'inconclusive' && (
              <div className="p-5 rounded-2xl border border-amber-500/50 bg-gradient-to-r from-amber-950/70 via-slate-900 to-amber-950/60 shadow-xl shadow-amber-950/30 flex flex-col gap-3">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="h-12 w-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0">
                      <AlertTriangle className="w-7 h-7" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-amber-200 tracking-tight">
                          Inconclusive — Not a Fake Verdict
                        </h3>
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                          Ambiguous Signals
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                        {analysisResult.assessmentExplanation}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-stretch md:self-auto justify-end">
                    <span className="text-xs text-amber-300 font-medium bg-amber-950/60 border border-amber-800/80 px-3 py-1.5 rounded-lg">
                      Not Enough Evidence to Decide
                    </span>
                  </div>
                </div>

                {/* Simple One-Word Observation in Easy Words */}
                <div className="p-3 rounded-xl bg-slate-950/80 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Simple Observation:</span>
                    <span className="font-bold px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      {analysisResult.simpleVerdict || 'Unclear — not a fake verdict'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-200 italic font-medium">
                    {analysisResult.easyWordsSummary || 'The checks cannot tell if this image is real or edited. Normal app graphics, resizing, or compression may cause the same signals. Check the original source.'}
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-xl border border-amber-700/50 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-100/90">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p>
                These are exploratory browser-based heuristics, not a validated forensic opinion. A flagged area is not proof of editing, and no flagged area does not prove authenticity. Verify important claims with the original file and the issuing platform.
              </p>
            </div>

            {/* Whole-image AI-origin result — local spectral check always runs; external is optional. */}
            <section className="border-4 border-cyan-500/50 bg-slate-900 p-5 shadow-lg" aria-live="polite">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-slate-100">AI Image-Origin Check</h3>
                  <p className="mt-1 text-xs text-slate-400">Local 2D-FFT spectral &amp; PRNU noise analysis — runs entirely in your browser with no external service.</p>
                </div>
                {/* Badge driven by localAiOrigin from the analysis result */}
                {analysisResult.localAiOrigin && (() => {
                  const lo = analysisResult.localAiOrigin!;
                  const isAiLike = lo.outcome === 'ai_generated_supported';
                  const isMixed = lo.outcome === 'mixed_content' || lo.outcome === 'possible_manipulation';
                  return (
                    <span className={`border px-2.5 py-1 text-xs font-bold ${
                      isAiLike
                        ? 'border-rose-500/60 bg-rose-950/50 text-rose-200'
                        : isMixed
                        ? 'border-amber-500/60 bg-amber-950/50 text-amber-200'
                        : 'border-emerald-500/60 bg-emerald-950/50 text-emerald-200'
                    }`}>
                      {isAiLike ? 'AI-Generated signals detected' : isMixed ? 'Mixed / partial anomaly' : 'No strong AI signals'}
                      {' · '}checkerboard {lo.highFreqCheckerboardScore.toFixed(0)}/100
                    </span>
                  );
                })()}
                {/* External API badge if that also ran */}
                {aiOriginStatus === 'complete' && aiOriginResult && (
                  <span className={`border px-2.5 py-1 text-xs font-bold ${
                    aiOriginResult.isAI
                      ? 'border-rose-500/60 bg-rose-950/50 text-rose-200'
                      : 'border-emerald-500/60 bg-emerald-950/50 text-emerald-200'
                  }`}>
                    External: {aiOriginResult.isAI ? 'AI signals detected' : 'No strong AI signals'}
                    {' · '}{Math.round(aiOriginResult.confidence * 100)}%
                  </span>
                )}
              </div>

              {/* Local spectral result — always shown */}
              {analysisResult.localAiOrigin && (() => {
                const lo = analysisResult.localAiOrigin!;
                const isAiLike = lo.outcome === 'ai_generated_supported';
                const isMixed = lo.outcome === 'mixed_content' || lo.outcome === 'possible_manipulation';
                return (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className={`border-2 p-3 ${isAiLike ? 'border-rose-500/40 bg-rose-950/20' : isMixed ? 'border-amber-500/40 bg-amber-950/20' : 'border-emerald-500/40 bg-emerald-950/20'}`}>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Simple observation</p>
                      <p className={`mt-1 text-sm font-bold ${isAiLike ? 'text-rose-200' : isMixed ? 'text-amber-200' : 'text-emerald-200'}`}>
                        {isAiLike ? 'AI-like — Synthetic generation detected' : isMixed ? 'Borderline — Possible mixed content' : 'No strong AI signal — Consistent with real screenshot'}
                      </p>
                    </div>
                    <div className="border-2 border-cyan-500/40 bg-slate-950/70 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Spectral measurements</p>
                      <div className="mt-1 space-y-0.5 text-xs text-slate-300">
                        <p>Checkerboard score: <span className={`font-mono font-bold ${lo.highFreqCheckerboardScore > 68 ? 'text-rose-300' : lo.highFreqCheckerboardScore > 58 ? 'text-amber-300' : 'text-emerald-300'}`}>{lo.highFreqCheckerboardScore.toFixed(1)}/100</span></p>
                        <p>Spectral energy ratio: <span className="font-mono text-cyan-300">{lo.spectralEnergyRatio.toFixed(2)}%</span></p>
                        <p>PRNU noise variance: <span className="font-mono text-cyan-300">{lo.prnuNoiseVariance.toFixed(1)}</span></p>
                      </div>
                    </div>
                    <div className="border-2 border-cyan-500/40 bg-slate-950/70 p-3 md:col-span-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Technical explanation</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">{lo.technicalExplanation}</p>
                    </div>
                    <p className="text-[11px] leading-relaxed text-slate-400 md:col-span-2">
                      This spectral check analyses the entire image for AI-generation patterns using 2D Fourier frequency analysis and PRNU camera noise residuals. It runs fully offline in your browser. The red boxes in the viewer come from the separate local pixel-manipulation analysis.
                    </p>
                  </div>
                );
              })()}

              {/* Abacus AI Smaug Detector & EasyOCR Result if microservice was queried */}
              {analysisResult.aiEvidenceDetector && (
                <div className="mt-4 border-2 border-indigo-500/50 bg-slate-950/80 p-4 rounded-xl">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-indigo-500/30">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-pulse" />
                      <h4 className="text-sm font-bold text-indigo-200">Abacus AI Smaug Detector &amp; EasyOCR</h4>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                        abacusai/Smaug-AI-Image-Detector
                      </span>
                    </div>
                    <span className={`px-2.5 py-1 text-xs font-bold rounded border ${
                      analysisResult.aiEvidenceDetector.isAiGenerated
                        ? 'border-rose-500/70 bg-rose-950/60 text-rose-200'
                        : 'border-emerald-500/70 bg-emerald-950/60 text-emerald-200'
                    }`}>
                      {analysisResult.aiEvidenceDetector.isAiGenerated ? 'AI-Generated Detected' : 'Human / Real Image'}
                      {' · '}{Math.round(analysisResult.aiEvidenceDetector.aiProbability * 100)}%
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-2 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                      <p className="font-semibold text-indigo-300">Auto-Classified Category</p>
                      <p className="mt-1 text-slate-100 font-bold">
                        {analysisResult.aiEvidenceDetector.evidenceCategory}
                        <span className="ml-2 font-normal text-slate-400">
                          ({Math.round(analysisResult.aiEvidenceDetector.categoryConfidence * 100)}% confidence)
                        </span>
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                      <p className="font-semibold text-indigo-300">Smaug AI Probability</p>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="flex-1 bg-slate-800 h-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${analysisResult.aiEvidenceDetector.isAiGenerated ? 'bg-rose-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.round(analysisResult.aiEvidenceDetector.aiProbability * 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-slate-200 font-bold">
                          {(analysisResult.aiEvidenceDetector.aiProbability * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {analysisResult.aiEvidenceDetector.extractedText && (
                    <div className="mt-3 p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs">
                      <p className="font-semibold text-indigo-300">EasyOCR Extracted Text</p>
                      <p className="mt-1 text-slate-300 font-mono text-[11px] bg-slate-950 p-2 rounded border border-slate-800 max-h-24 overflow-y-auto whitespace-pre-wrap">
                        {analysisResult.aiEvidenceDetector.extractedText}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* External service state */}
              {aiOriginStatus === 'checking' && (
                <p className="mt-3 text-sm text-cyan-200">Also checking image origin with the external service…</p>
              )}
              {aiOriginStatus === 'skipped' && !analysisResult.localAiOrigin && (
                <p className="mt-3 text-sm text-slate-300">Not run. No image was sent to the external AI-origin service.</p>
              )}
              {aiOriginStatus === 'failed' && (
                <p className="mt-3 text-sm text-rose-200" role="alert">
                  External AI-origin check unavailable: {aiOriginError}
                </p>
              )}
              {aiOriginStatus === 'complete' && aiOriginResult && (
                <div className="mt-3 grid gap-3 md:grid-cols-2 border-t border-slate-700 pt-3">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide md:col-span-2">External API result (wasitaigenerated.com)</p>
                  <div className="border-2 border-cyan-500/40 bg-slate-950/70 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Verdict</p>
                    <p className="mt-1 text-sm font-bold text-slate-100">
                      {aiOriginResult.isAI ? 'AI-like' : 'No strong AI signal'}
                    </p>
                  </div>
                  <div className="border-2 border-cyan-500/40 bg-slate-950/70 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
                      {aiOriginResult.isAI ? 'Why it was flagged' : 'What this means'}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-200">
                      {aiOriginResult.analysis?.reasoning
                        || (aiOriginResult.isAI
                          ? 'The service detected patterns associated with AI-generated imagery.'
                          : 'The service did not find strong AI-generation signals. This does not prove the image was made by a person.')}
                    </p>
                  </div>
                  {aiOriginResult.c2pa && (
                    <div className="border-2 border-amber-500/40 bg-amber-950/20 p-3 text-xs text-slate-200 md:col-span-2">
                      <p className="font-semibold text-amber-200">Content credentials</p>
                      <p className="mt-1">
                        {[aiOriginResult.c2pa.generator, aiOriginResult.c2pa.vendor].filter(Boolean).join(' · ') || 'Present'}
                        {aiOriginResult.c2pa.signedAt ? ` · Signed ${new Date(aiOriginResult.c2pa.signedAt).toLocaleString()}` : ''}
                        {typeof aiOriginResult.c2pa.signatureValid === 'boolean'
                          ? ` · Signature ${aiOriginResult.c2pa.signatureValid ? 'valid' : 'invalid'}`
                          : ''}
                        {aiOriginResult.c2pa.trusted === false ? ' · Signer is not marked trusted' : ''}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Main Interactive Visual Evidence Workspace */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              
              {/* Left / Center: Interactive Canvas Viewer (8 cols) */}
              <div className="lg:col-span-8 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 border border-slate-800 p-2.5 rounded-xl">
                  {/* View Mode Tabs */}
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs font-semibold">
                    <button
                      onClick={() => setViewMode('side_by_side')}
                      className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                        viewMode === 'side_by_side'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>Side by Side</span>
                    </button>
                    <button
                      onClick={() => setViewMode('annotated')}
                      className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                        viewMode === 'annotated'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Target className="w-3.5 h-3.5" />
                      <span>Annotated Regions</span>
                    </button>
                    <button
                      onClick={() => setViewMode('heatmap')}
                      className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                        viewMode === 'heatmap'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>Manipulation Heatmap</span>
                    </button>
                    <button
                      onClick={() => setViewMode('slider')}
                      className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                        viewMode === 'slider'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Before / After Slider</span>
                    </button>
                    <button
                      onClick={() => setViewMode('original')}
                      className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                        viewMode === 'original'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Original</span>
                    </button>
                  </div>

                  {/* Zoom and Display Controls */}
                  <div className="flex items-center gap-1.5 text-xs text-slate-300">
                    <button
                      onClick={() => setShowBoxes((v) => !v)}
                      className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                        showBoxes
                          ? 'bg-cyan-950/60 border-cyan-600/50 text-cyan-300'
                          : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                      title={showBoxes ? 'Hide Forensic Overlays' : 'Show Forensic Overlays'}
                    >
                      {showBoxes ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>

                    <button
                      onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
                      className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 transition-all cursor-pointer"
                      title="Zoom In"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setZoomLevel((z) => Math.max(0.5, z - 0.25))}
                      className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 transition-all cursor-pointer"
                      title="Zoom Out"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setZoomLevel(1)}
                      className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold transition-all cursor-pointer"
                      title="Reset Zoom"
                    >
                      {Math.round(zoomLevel * 100)}%
                    </button>
                  </div>
                </div>

                {/* Heatmap Opacity Slider (When in Heatmap Mode) */}
                {viewMode === 'heatmap' && (
                  <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/60 border border-slate-800 rounded-lg text-xs text-slate-300">
                    <span className="text-slate-400">Heatmap Intensity:</span>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={heatmapOpacity}
                      onChange={(e) => setHeatmapOpacity(parseFloat(e.target.value))}
                      className="flex-1 accent-cyan-500 cursor-pointer"
                    />
                    <span className="font-mono text-cyan-400 w-10 text-right">
                      {Math.round(heatmapOpacity * 100)}%
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-300">
                  <span className="font-semibold text-slate-400">Region boxes by check:</span>
                  {Object.entries(analysisResult.moduleFindings).map(([moduleId, finding]) => (
                    <label key={moduleId} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={visibleModuleOverlays[moduleId] ?? true}
                        onChange={(event) => setVisibleModuleOverlays((current) => ({
                          ...current,
                          [moduleId]: event.target.checked,
                        }))}
                        className="accent-cyan-500"
                      />
                      <span>{finding.name}</span>
                    </label>
                  ))}
                </div>

                {/* Visual View Canvas Area */}
                <div
                  ref={canvasContainerRef}
                  className="relative rounded-2xl border border-slate-800 bg-slate-950 overflow-hidden flex items-center justify-center p-4 min-h-[440px] select-none"
                  style={{ cursor: viewMode === 'slider' ? 'ew-resize' : 'default' }}
                >
                  <div
                    className="relative transition-transform duration-100 ease-out flex items-center justify-center max-w-full"
                    style={{ transform: `scale(${zoomLevel})` }}
                  >
                    {/* View: Original Image */}
                    {viewMode === 'original' && (
                      <img
                        src={analysisResult.originalDataUrl}
                        alt="Original Evidence"
                        className="max-h-[520px] w-auto object-contain rounded-lg shadow-2xl"
                      />
                    )}

                    {viewMode === 'side_by_side' && (
                      <div className="grid w-full grid-cols-1 gap-4 xl:grid-cols-2">
                        <div className="flex min-w-0 flex-col items-center gap-2">
                          <span className="text-xs font-semibold text-slate-300">Original uploaded image</span>
                          <img
                            src={analysisResult.originalDataUrl}
                            alt="Original uploaded evidence"
                            className="max-h-[520px] max-w-full object-contain rounded-lg shadow-2xl"
                          />
                        </div>
                        <div className="flex min-w-0 flex-col items-center gap-2">
                          <span className="text-xs font-semibold text-slate-300">Analysis regions</span>
                          <div className="relative inline-block max-w-full">
                            <img
                              src={analysisResult.originalDataUrl}
                              alt="Original image with measured region overlays"
                              className="max-h-[520px] max-w-full object-contain rounded-lg shadow-2xl block"
                            />
                            {showBoxes && Object.entries(analysisResult.moduleOverlayDataUrls || {})
                              .filter(([moduleId]) => visibleModuleOverlays[moduleId])
                              .map(([moduleId, overlayUrl]) => (
                                <img
                                  key={moduleId}
                                  src={overlayUrl}
                                  alt={`${analysisResult.moduleFindings[moduleId as keyof typeof analysisResult.moduleFindings]?.name || moduleId} detected region overlay`}
                                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                                />
                              ))}
                            {showBoxes && analysisResult.suspiciousRegions
                              .filter((region) => region.modules.some((moduleId) => visibleModuleOverlays[moduleId]))
                              .map((region) => (
                                <button
                                  key={region.id}
                                  type="button"
                                  aria-label={`Select region ${region.regionNumber}: ${region.label}`}
                                  onClick={() => setActiveRegionId(region.id)}
                                  style={{
                                    position: 'absolute',
                                    left: `${region.box.x * 100}%`,
                                    top: `${region.box.y * 100}%`,
                                    width: `${region.box.width * 100}%`,
                                    height: `${region.box.height * 100}%`,
                                  }}
                                  className={`rounded border-2 ${
                                    region.signalLevel === 'corroborated'
                                      ? 'border-rose-400 bg-rose-500/20'
                                      : 'border-amber-300 bg-amber-400/15'
                                  } ${activeRegionId === region.id ? 'ring-4 ring-cyan-400' : ''}`}
                                />
                              ))}
                          </div>
                          {analysisResult.suspiciousRegions.length === 0 && (
                            <p className="text-xs text-slate-400">No region was flagged by the implemented tests.</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* View: Annotated with Interactive Bounding Boxes */}
                    {viewMode === 'annotated' && (
                      <div className="relative inline-block">
                        <img
                          src={analysisResult.originalDataUrl}
                          alt="Evidence with Annotations"
                          className="max-h-[520px] w-auto object-contain rounded-lg shadow-2xl block"
                        />
                        {showBoxes && Object.entries(analysisResult.moduleOverlayDataUrls || {})
                          .filter(([moduleId]) => visibleModuleOverlays[moduleId])
                          .map(([moduleId, overlayUrl]) => (
                            <img
                              key={moduleId}
                              src={overlayUrl}
                              alt={`${analysisResult.moduleFindings[moduleId as keyof typeof analysisResult.moduleFindings]?.name || moduleId} detected region overlay`}
                              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                            />
                          ))}
                        {/* Interactive Overlay Bounding Boxes */}
                        {showBoxes &&
                          analysisResult.suspiciousRegions
                            .filter((region) => region.modules.some((moduleId) => visibleModuleOverlays[moduleId]))
                            .map((region) => {
                            const isSelected = activeRegionId === region.id;
                            const borderColor = region.signalLevel === 'corroborated'
                              ? 'border-rose-400'
                              : 'border-amber-300';
                            const bgColor = region.signalLevel === 'corroborated'
                              ? 'bg-rose-500/20'
                              : 'bg-amber-400/15';

                            return (
                              <div
                                key={region.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveRegionId(region.id);
                                }}
                                style={{
                                  position: 'absolute',
                                  left: `${region.box.x * 100}%`,
                                  top: `${region.box.y * 100}%`,
                                  width: `${region.box.width * 100}%`,
                                  height: `${region.box.height * 100}%`,
                                }}
                                className={`border-2 rounded transition-all cursor-pointer group ${borderColor} ${bgColor} ${
                                  isSelected ? 'ring-4 ring-cyan-400 shadow-lg shadow-cyan-500/40 z-20' : 'z-10'
                                }`}
                              >
                                {/* Tooltip tag */}
                                <div
                                  className={`absolute -top-6 left-0 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-tight whitespace-nowrap shadow-md pointer-events-none ${
                                    isSelected
                                      ? 'bg-cyan-500 text-slate-950'
                                      : 'bg-slate-900/90 text-slate-200 border border-slate-700'
                                  }`}
                                >
                                  #{region.regionNumber} · {region.label}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {/* View: Manipulation Heatmap Overlay */}
                    {viewMode === 'heatmap' && (
                      <div className="relative inline-block">
                        <img
                          src={analysisResult.originalDataUrl}
                          alt="Base Evidence"
                          className="max-h-[520px] w-auto object-contain rounded-lg shadow-2xl block"
                        />
                        {showBoxes && Object.entries(analysisResult.moduleOverlayDataUrls || {})
                          .filter(([moduleId]) => visibleModuleOverlays[moduleId])
                          .map(([moduleId, overlayUrl]) => (
                            <img
                              key={moduleId}
                              src={overlayUrl}
                              alt={`${analysisResult.moduleFindings[moduleId as keyof typeof analysisResult.moduleFindings]?.name || moduleId} forensic heatmap overlay`}
                              style={{ opacity: heatmapOpacity }}
                              className="absolute inset-0 h-full w-full object-contain pointer-events-none"
                            />
                          ))}
                      </div>
                    )}

                    {/* View: Interactive Split Slider (Before / After) */}
                    {viewMode === 'slider' && (
                      <div className="relative inline-block select-none overflow-hidden rounded-lg shadow-2xl">
                        {/* Background: Original Screenshot */}
                        <img
                          src={analysisResult.originalDataUrl}
                          alt="Original View"
                          className="max-h-[520px] w-auto object-contain block pointer-events-none"
                        />

                        {/* Foreground: Heatmap + Annotations clipped to slider percentage */}
                        <div
                          className="absolute inset-0 overflow-hidden pointer-events-none"
                          style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
                        >
                          <img
                            src={analysisResult.originalDataUrl}
                            alt=""
                            className="max-h-[520px] w-auto object-contain block"
                          />
                          <img
                            src={analysisResult.heatmapDataUrl}
                            alt=""
                            className="absolute inset-0 max-h-[520px] w-full h-full object-contain mix-blend-screen opacity-90"
                          />
                        </div>

                        {/* Draggable Divider Line */}
                        <div
                          onMouseDown={handleSliderMouseDown}
                          style={{ left: `${sliderPosition}%` }}
                          className="absolute top-0 bottom-0 w-1 bg-cyan-400 cursor-ew-resize flex items-center justify-center -translate-x-1/2 z-30 shadow-[0_0_10px_rgba(6,182,212,0.8)]"
                        >
                          <div className="h-8 w-8 rounded-full bg-slate-900 border-2 border-cyan-400 flex items-center justify-center text-cyan-300 shadow-xl">
                            <Sliders className="w-4 h-4 rotate-90" />
                          </div>
                        </div>

                        {/* Slider Labels */}
                        <div className="absolute top-3 left-3 px-2 py-1 rounded bg-slate-900/80 border border-slate-700 text-[10px] font-bold text-slate-300 pointer-events-none">
                          Original View
                        </div>
                        <div className="absolute top-3 right-3 px-2 py-1 rounded bg-cyan-950/80 border border-cyan-700 text-[10px] font-bold text-cyan-300 pointer-events-none">
                          Forensic Heatmap
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Heatmap Legend Bar */}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-900/60 border border-slate-800 rounded-xl text-xs text-slate-400">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Relative Pixel Signal:
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-blue-400 font-medium">Lower signal</span>
                    <div className="h-2.5 w-36 rounded-full bg-gradient-to-r from-blue-600 via-cyan-400 via-yellow-400 to-red-600 shadow-inner" />
                    <span className="text-[10px] text-rose-400 font-bold">Higher signal</span>
                  </div>
                </div>
                <p className="px-1 text-[11px] leading-relaxed text-slate-500">
                  Heatmap colors show relative signal strength within this image; they are not probabilities or proof of editing.
                </p>
              </div>

              {/* Right: Suspicious Regions Inspector & Evidence Info (4 cols) */}
              <div className="lg:col-span-4 flex flex-col gap-4">
                
                {/* Evidence Metadata Card */}
                <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider">
                      <Hash className="w-4 h-4 text-cyan-400" />
                      <span>Evidence Identity</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {analysisResult.imageDimensions.width} × {analysisResult.imageDimensions.height} px
                    </span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400">File Name:</span>
                      <span className="font-semibold text-slate-200 truncate max-w-[170px]" title={analysisResult.fileName}>
                        {analysisResult.fileName}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400">Evidence ID:</span>
                      <span className="font-mono text-cyan-400">{analysisResult.evidenceId}</span>
                    </div>

                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400">Processing Time:</span>
                      <span className="text-slate-300 font-medium">{analysisResult.processingTimeMs} ms</span>
                    </div>

                    {/* SHA-256 with Copy */}
                    <div className="pt-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                        <span>SHA-256 Digest:</span>
                        <button
                          onClick={() => handleCopyHash(analysisResult.sha256, 'sha256')}
                          className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                        >
                          {copiedHash === 'sha256' ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400 text-[10px]">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span className="text-[10px]">Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                      <div className="p-1.5 rounded-lg bg-slate-950 font-mono text-[10px] text-slate-300 break-all select-all border border-slate-800">
                        {analysisResult.sha256}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Isolated Suspicious Regions Drawer */}
                <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl flex flex-col gap-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider">
                      <Target className="w-4 h-4 text-rose-400" />
                      <span>Isolated Regions ({analysisResult.suspiciousRegions.length})</span>
                    </div>
                    {analysisResult.suspiciousRegions.length > 0 && (
                      <span className="text-[10px] font-semibold text-rose-300 bg-rose-950/60 border border-rose-800 px-2 py-0.5 rounded-full">
                        Requires Audit
                      </span>
                    )}
                  </div>

                  {analysisResult.suspiciousRegions.length === 0 ? (
                    <div className="text-center py-6 px-4 bg-slate-950/60 rounded-xl border border-slate-800/80 space-y-2">
                      <ShieldCheck className="w-8 h-8 text-emerald-400 mx-auto" />
                      <p className="text-xs font-semibold text-slate-200">
                        No Local Anomaly Clusters Found
                      </p>
                      <p className="text-[11px] text-slate-400">
                        No localized region was flagged by the tests that ran. Review module availability and limitations before drawing conclusions.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 max-h-[460px] overflow-y-auto pr-1">
                      {analysisResult.suspiciousRegions.map((region) => {
                        const isSelected = activeRegionId === region.id;
                        const isRecorded = recordedFindings.has(region.id);

                        return (
                          <div
                            key={region.id}
                            onClick={() => setActiveRegionId(region.id)}
                            className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-2.5 ${
                              isSelected
                                ? 'border-cyan-400 bg-slate-950 shadow-md shadow-cyan-950/50'
                                : 'border-slate-800 bg-slate-950/60 hover:bg-slate-950/90 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="h-5 w-5 rounded-md bg-cyan-500/20 text-cyan-400 font-bold text-[10px] flex items-center justify-center border border-cyan-500/40">
                                  #{region.regionNumber}
                                </span>
                                <h4 className="text-xs font-bold text-slate-200 truncate">
                                  {region.label}
                                </h4>
                              </div>
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                                  region.signalLevel === 'corroborated'
                                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                }`}
                              >
                                {region.signalLevel === 'corroborated' ? 'Multiple checks' : 'Single check'}
                              </span>
                            </div>

                            {/* Pixel Coordinates */}
                            <div className="text-[10px] font-mono text-slate-400 flex items-center gap-2 bg-slate-900/80 px-2 py-1 rounded">
                              <span>Box:</span>
                              <span>
                                X: {region.pixelBox.x}, Y: {region.pixelBox.y}, W: {region.pixelBox.width}, H: {region.pixelBox.height}
                              </span>
                            </div>

                            {/* One Simple Word Observation & Easy Words */}
                            <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-200 text-xs flex flex-col gap-1 shadow-inner">
                              <div className="flex items-center gap-1.5 font-bold text-xs text-emerald-300">
                                <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                <span>Simple Observation: {region.simpleObservation || 'Local difference'}</span>
                              </div>
                              <p className="text-[11px] text-emerald-100/90 leading-relaxed font-medium">
                                {region.easyWords || 'This check found a local difference. It does not show whether anyone edited the image.'}
                              </p>
                            </div>

                            {/* Reason for Flagging (Plain English) */}
                            <p className="text-xs text-slate-300 leading-snug">
                              {region.reason}
                            </p>

                            {/* Technical Observation */}
                            <div className="text-[11px] text-cyan-200/90 bg-cyan-950/30 border border-cyan-900/50 p-2 rounded-lg leading-relaxed">
                              <span className="font-semibold text-cyan-400">Technical observation: </span>
                              {region.technicalObservations}
                            </div>

                            {/* Action: Add to Findings Register */}
                            <div className="flex items-center justify-between pt-1">
                              <span className="text-[10px] text-slate-500 italic">
                                {region.technique}
                              </span>
                              {onAddFinding && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRecordRegionFinding(region);
                                  }}
                                  disabled={isRecorded}
                                  className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                                    isRecorded
                                      ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800 cursor-default'
                                      : 'bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-700/80 hover:border-cyan-500'
                                  }`}
                                >
                                  {isRecorded ? (
                                    <>
                                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                      <span>Recorded</span>
                                    </>
                                  ) : (
                                    <>
                                      <FileText className="w-3 h-3 text-cyan-400" />
                                      <span>Record Finding</span>
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ========================================================================= */}
            {/* 7 EXPANDABLE TECHNICAL MODULE FINDINGS CARDS                             */}
            {/* ========================================================================= */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <div>
                  <h3 className="text-base font-bold text-slate-100 tracking-tight">
                    Forensic Engine Modules Breakdown
                  </h3>
                  <p className="text-xs text-slate-400">
                    Scientific analysis results across all 7 optical, spatial, and frequency-domain filters
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const allOpen = Object.values(expandedModules).every(Boolean);
                      const updated: Record<string, boolean> = {};
                      Object.keys(analysisResult.moduleFindings).forEach((key) => {
                        updated[key] = !allOpen;
                      });
                      setExpandedModules(updated);
                    }}
                    className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
                  >
                    {Object.values(expandedModules).every(Boolean) ? 'Collapse All' : 'Expand All'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.entries(analysisResult.moduleFindings).map(([key, finding]) => {
                  const isExpanded = !!expandedModules[key];
                  const isFlagged = finding.status === 'flagged';
                  const isClean = finding.status === 'clean';

                  return (
                    <div
                      key={key}
                      className={`rounded-2xl border transition-all overflow-hidden ${
                        isFlagged
                          ? 'border-rose-500/40 bg-slate-900/90 shadow-lg shadow-rose-950/20'
                          : 'border-slate-800 bg-slate-900/60'
                      }`}
                    >
                      {/* Module Header */}
                      <button
                        onClick={() => toggleModule(key)}
                        className="w-full p-4 flex items-center justify-between text-left cursor-pointer hover:bg-slate-800/40 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-9 w-9 rounded-xl flex items-center justify-center font-bold text-xs ${
                              isFlagged
                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            }`}
                          >
                            {isFlagged ? (
                              <ShieldAlert className="w-5 h-5" />
                            ) : (
                              <ShieldCheck className="w-5 h-5" />
                            )}
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-slate-200">{finding.name}</h4>
                            <p className="text-[11px] text-slate-400 line-clamp-1">
                              {finding.whatWasFound}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                              isFlagged
                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                : isClean
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            }`}
                          >
                            {finding.status}
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-slate-400" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-slate-400" />
                          )}
                        </div>
                      </button>

                      {/* Expanded Module Details */}
                      {isExpanded && (
                        <div className="p-4 pt-1 border-t border-slate-800/80 bg-slate-950/50 space-y-3 text-xs">
                          {/* One Simple Word Observation & Easy Words */}
                          <div className="p-2.5 rounded-xl bg-cyan-950/40 border border-cyan-700/50 text-cyan-200 text-xs flex flex-col gap-1">
                            <div className="flex items-center gap-1.5 font-bold text-xs text-cyan-300">
                              <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                              <span>Simple Observation: {finding.simpleObservation || 'Inspected'}</span>
                            </div>
                            <p className="text-[11px] text-cyan-100/90 leading-relaxed font-medium">
                              {finding.easyWords || 'Measurements are descriptive and have not been calibrated against an authenticity dataset.'}
                            </p>
                          </div>

                          {/* Metrics Bar */}
                          {Object.keys(finding.metrics).length > 0 && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 py-2">
                              {Object.entries(finding.metrics).map(([mKey, mVal]) => (
                                <div
                                  key={mKey}
                                  className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-center"
                                >
                                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                                    {mKey}
                                  </span>
                                  <span className="font-mono font-bold text-cyan-300 text-xs">
                                    {typeof mVal === 'number' ? mVal.toLocaleString() : mVal}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-2.5">
                            <span className="font-semibold text-slate-300 text-[11px]">Recorded thresholds:</span>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {Object.entries(finding.thresholds).map(([thresholdKey, thresholdValue]) => (
                                <span key={thresholdKey} className="rounded bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-300">
                                  {thresholdKey}: {thresholdValue}
                                </span>
                              ))}
                            </div>
                          </div>

                          {/* 4 Standard Forensic Explanations */}
                          <div className="space-y-2">
                            <div>
                              <span className="font-semibold text-slate-300 text-[11px]">
                                What was evaluated:
                              </span>
                              <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">
                                {finding.whatWasChecked}
                              </p>
                            </div>

                            <div>
                              <span className="font-semibold text-slate-300 text-[11px]">
                                Why this matters forensically:
                              </span>
                              <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">
                                {finding.whyItMatters}
                              </p>
                            </div>

                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                              <span className="font-semibold text-slate-300 block">
                                Interpretation & Known Limitations:
                              </span>
                              <p className="leading-relaxed">
                                <strong className="text-cyan-400">Reliability:</strong> {finding.reliability}
                              </p>
                              <p className="leading-relaxed">
                                <strong className="text-amber-400">Limitations:</strong> {finding.limitations}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Bottom Action Footer */}
            <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-4 mt-2">
              <div className="space-y-0.5">
                <h4 className="text-sm font-bold text-slate-200">
                  Investigation report
                </h4>
                <p className="text-xs text-slate-400">
                  {currentCase
                    ? `The PDF will include this analysis and ${investigationAnalyses.length} saved screenshot analysis record(s) from this investigation.`
                    : 'Download this screenshot analysis report or annotated image evidence.'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handlePreviewReport}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Preview PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadImage(analysisResult.annotatedDataUrl || analysisResult.originalDataUrl, 'annotated')}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Annotated Image</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDownloadImage(analysisResult.heatmapDataUrl, 'heatmap')}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Thermal Heatmap</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadReport}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-bold shadow-lg shadow-cyan-900/40 transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <FileText className="w-4 h-4" />
                  <span>{currentCase ? 'Download Investigation PDF' : 'Download Analysis PDF'}</span>
                </button>
              </div>
              {reportError && <p className="mt-2 text-xs text-rose-300">{reportError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

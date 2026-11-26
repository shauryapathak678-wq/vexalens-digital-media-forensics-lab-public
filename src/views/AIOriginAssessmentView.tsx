import React, { useState, useEffect } from 'react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import {
  BrainCircuit,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Plus,
  RefreshCw,
  Info,
  ScanEye,
  Film,
  Video,
  Play,
  Timer,
  AudioLines,
} from 'lucide-react';
import {
  getTruthScanVideoPresentation,
  getTruthScanVideoCredits,
  queryTruthScanVideo,
  submitTruthScanVideo,
  TruthScanVideoCredits,
  TruthScanVideoModel,
  TruthScanVideoResult,
} from '@/lib/forensics/truthScanVideoDetector';
import { VideoDeepfakeScanResult } from '@/types/forensics';
import { scanVideoDeepfakeForensics } from '@/lib/forensics/videoScanner';
import {
  analyzeWithPuterAI,
  connectPuterAccount,
  formatPuterError,
  formatPuterMicrocents,
  getDefaultPuterModel,
  getPuterMonthlyUsage,
  isPuterAvailable,
  isPuterSignedIn,
  listPuterModels,
  loadOriginalImageFile,
  requestPuterAccountSwitch,
  type PuterModelOption,
  type PuterVisualAssessment,
  type PuterVisualAssessmentResult,
  type PuterMonthlyUsage,
  type PuterTokenProgress,
} from '@/lib/forensics/puterAiDetector';
import { savePuterImageDetectionResult } from '@/lib/forensics/puterDetectionStore';
import {
  analyzeContrastiveDeepfake,
  type ContrastiveDeepfakeResult,
} from '@/lib/forensics/contrastiveDeepfakeDetector';

interface AIOriginAssessmentViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
  onNavigateTab?: (tab: string) => void;
}

type TabType = 'origin' | 'video';

const puterAssessmentLabels: Record<PuterVisualAssessment, string> = {
  possible_ai_generated: 'Possible AI-Generated',
  camera_consistent: 'More Consistent with Camera Photography',
  possible_ai_assisted_editing: 'Possible AI-Assisted Editing',
  inconclusive: 'Inconclusive',
};

const puterSimpleResults: Record<PuterVisualAssessment, { label: string; style: string }> = {
  possible_ai_generated: {
    label: 'Possible AI image',
    style: 'border-rose-700 bg-rose-950/50 text-rose-100',
  },
  camera_consistent: {
    label: 'Looks like a camera photo',
    style: 'border-emerald-700 bg-emerald-950/50 text-emerald-100',
  },
  possible_ai_assisted_editing: {
    label: 'Possible AI edits',
    style: 'border-rose-700 bg-rose-950/50 text-rose-100',
  },
  inconclusive: {
    label: 'Not sure',
    style: 'border-amber-700 bg-amber-950/50 text-amber-100',
  },
};

export const AIOriginAssessmentView: React.FC<AIOriginAssessmentViewProps> = ({
  evidenceList,
  selectedItem,
  onSelectEvidence,
  onAddFinding,
  onNavigateTab,
}) => {
  const imageEvidence = evidenceList.filter((e) => e.mediaType === 'image');
  const videoEvidence = evidenceList.filter((e) => e.mediaType === 'video');

  const activeItem =
    selectedItem && selectedItem.mediaType === 'image'
      ? selectedItem
      : imageEvidence[0];

  // Active video for the video tab
  const [activeVideoItem, setActiveVideoItem] = useState<EvidenceItem | undefined>(
    selectedItem?.mediaType === 'video' ? selectedItem : videoEvidence[0]
  );

  const [activeTab, setActiveTab] = useState<TabType>(
    selectedItem?.mediaType === 'video' ? 'video' : 'origin'
  );
  const [puterConsent, setPuterConsent] = useState(false);
  const [puterLoading, setPuterLoading] = useState(false);
  const [puterError, setPuterError] = useState<string | null>(null);
  const [puterResult, setPuterResult] = useState<PuterVisualAssessmentResult | null>(null);
  const [puterModels, setPuterModels] = useState<PuterModelOption[]>([]);
  const [selectedPuterModelId, setSelectedPuterModelId] = useState('');
  const [puterModelsLoading, setPuterModelsLoading] = useState(false);
  const [puterModelsError, setPuterModelsError] = useState<string | null>(null);
  const [puterModelsRefreshKey, setPuterModelsRefreshKey] = useState(0);
  const [puterAvailable, setPuterAvailable] = useState(isPuterAvailable);
  const [puterSignedIn, setPuterSignedIn] = useState(isPuterSignedIn);
  const [puterConnectLoading, setPuterConnectLoading] = useState(false);
  const [puterUsage, setPuterUsage] = useState<PuterMonthlyUsage | null>(null);
  const [puterUsageLoading, setPuterUsageLoading] = useState(false);
  const [puterUsageError, setPuterUsageError] = useState<string | null>(null);
  const [puterUsageRefreshKey, setPuterUsageRefreshKey] = useState(0);
  const [puterAccountMessage, setPuterAccountMessage] = useState<string | null>(null);
  const [puterTokenProgress, setPuterTokenProgress] = useState<PuterTokenProgress | null>(null);
  const [puterSaveMessage, setPuterSaveMessage] = useState<string | null>(null);
  const [contrastiveDeepfakeLoading, setContrastiveDeepfakeLoading] = useState(false);
  const [contrastiveDeepfakeError, setContrastiveDeepfakeError] = useState<string | null>(null);
  const [contrastiveDeepfakeResult, setContrastiveDeepfakeResult] = useState<ContrastiveDeepfakeResult | null>(null);
  const selectedPuterModel = puterModels.find((model) => model.modelId === selectedPuterModelId);

  const puterRequestId = React.useRef(0);
  const contrastiveDeepfakeRequestId = React.useRef(0);

  // Video AI Detection State
  const [videoResult, setVideoResult] = useState<VideoDeepfakeScanResult | null>(null);
  const [videoAnalyzing, setVideoAnalyzing] = useState(false);
  const [videoSamplingInterval, setVideoSamplingInterval] = useState(1.0);
  const [videoMaxFrames, setVideoMaxFrames] = useState(12);
  const [videoSavedSuccess, setVideoSavedSuccess] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [truthScanVideoModel, setTruthScanVideoModel] = useState<TruthScanVideoModel>('generic');
  const [truthScanVideoResult, setTruthScanVideoResult] = useState<TruthScanVideoResult | null>(null);
  const [truthScanVideoConsent, setTruthScanVideoConsent] = useState(false);
  const [truthScanVideoBusy, setTruthScanVideoBusy] = useState(false);
  const [truthScanVideoStage, setTruthScanVideoStage] = useState('');
  const [truthScanVideoError, setTruthScanVideoError] = useState<string | null>(null);
  const [truthScanVideoSaved, setTruthScanVideoSaved] = useState(false);
  const [truthScanVideoCredits, setTruthScanVideoCredits] = useState<TruthScanVideoCredits | null>(null);
  const [truthScanVideoCreditsError, setTruthScanVideoCreditsError] = useState<string | null>(null);
  const [truthScanVideoCreditsLoading, setTruthScanVideoCreditsLoading] = useState(false);
  const truthScanVideoRequestId = React.useRef(0);
  const videoScanRequestId = React.useRef(0);

  useEffect(() => {
    let attempts = 0;
    const updateStatus = () => {
      setPuterAvailable(isPuterAvailable());
      setPuterSignedIn(isPuterSignedIn());
    };
    updateStatus();
    const timer = window.setInterval(() => {
      attempts += 1;
      updateStatus();
      if ((isPuterAvailable() && isPuterSignedIn()) || attempts >= 20) {
        window.clearInterval(timer);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!puterAvailable) return;
    let active = true;
    setPuterModelsLoading(true);
    setPuterModelsError(null);
    void listPuterModels()
      .then((models) => {
        if (!active) return;
        setPuterModels(models);
        const defaultModel = getDefaultPuterModel(models);
        setSelectedPuterModelId((current) =>
          models.some((model) => model.modelId === current)
            ? current
            : defaultModel?.modelId ?? '',
        );
        if (!models.length) {
          setPuterModelsError('Puter did not return any image models from Google, OpenAI, or Claude.');
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setPuterModels([]);
          setSelectedPuterModelId('');
          setPuterModelsError(error instanceof Error ? error.message : 'Could not load available AI models.');
        }
      })
      .finally(() => {
        if (active) setPuterModelsLoading(false);
      });
    return () => { active = false; };
  }, [puterAvailable, puterModelsRefreshKey]);

  useEffect(() => {
    puterRequestId.current += 1;
    contrastiveDeepfakeRequestId.current += 1;
    setPuterConsent(false);
    setPuterLoading(false);
    setPuterError(null);
    setPuterResult(null);
    setPuterSaveMessage(null);
    setPuterTokenProgress(null);
    setContrastiveDeepfakeLoading(false);
    setContrastiveDeepfakeError(null);
    setContrastiveDeepfakeResult(null);
  }, [activeItem?.id]);

  useEffect(() => {
    if (!puterAvailable || !puterSignedIn) {
      setPuterUsage(null);
      return;
    }
    let active = true;
    setPuterUsageLoading(true);
    setPuterUsageError(null);
    void getPuterMonthlyUsage()
      .then((usage) => {
        if (active) setPuterUsage(usage);
      })
      .catch(() => {
        if (active) {
          setPuterUsage(null);
          setPuterUsageError('Usage information currently unavailable.');
        }
      })
      .finally(() => {
        if (active) setPuterUsageLoading(false);
      });
    return () => { active = false; };
  }, [puterAvailable, puterSignedIn, puterUsageRefreshKey]);

  useEffect(() => {
    if (selectedItem?.mediaType === 'video') {
      if (selectedItem.id !== activeVideoItem?.id) setActiveVideoItem(selectedItem);
      setActiveTab('video');
    } else if (!activeVideoItem && videoEvidence.length) {
      setActiveVideoItem(videoEvidence[0]);
    } else if (activeVideoItem && !videoEvidence.some((item) => item.id === activeVideoItem.id)) {
      setActiveVideoItem(videoEvidence[0]);
    }
  }, [videoEvidence, activeVideoItem?.id, selectedItem?.id, selectedItem?.mediaType]);

  useEffect(() => {
    videoScanRequestId.current += 1;
    setVideoAnalyzing(false);
    setVideoResult(null);
    setVideoError(null);
    truthScanVideoRequestId.current += 1;
    setTruthScanVideoBusy(false);
    setTruthScanVideoConsent(false);
    setTruthScanVideoResult(null);
    setTruthScanVideoError(null);
    setTruthScanVideoStage('');
    setTruthScanVideoSaved(false);
  }, [activeVideoItem?.id]);

  const refreshTruthScanVideoCredits = async (): Promise<TruthScanVideoCredits | null> => {
    setTruthScanVideoCreditsLoading(true);
    setTruthScanVideoCreditsError(null);
    try {
      const credits = await getTruthScanVideoCredits();
      setTruthScanVideoCredits(credits);
      return credits;
    } catch (error) {
      setTruthScanVideoCreditsError(error instanceof Error ? error.message : 'Could not retrieve TruthScan video credits.');
      return null;
    } finally {
      setTruthScanVideoCreditsLoading(false);
    }
  };

  useEffect(() => {
    void refreshTruthScanVideoCredits();
  }, []);

  const runPuterAssessment = async () => {
    if (!activeItem || !puterConsent) return;
    if (!selectedPuterModel) {
      setPuterError('Choose an available image model before starting the analysis.');
      return;
    }
    if (!isPuterAvailable()) {
      setPuterAvailable(false);
      setPuterError('The Puter service is unavailable. Check your connection and reload the app.');
      return;
    }
    if (!isPuterSignedIn()) {
      setPuterSignedIn(false);
      setPuterError('Please connect your Puter account to continue.');
      return;
    }

    const target = activeItem;
    const requestId = ++puterRequestId.current;
    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(
      () => timeoutController.abort(new DOMException('The Puter image analysis timed out.', 'TimeoutError')),
      90_000,
    );
    setPuterAvailable(true);
    setPuterLoading(true);
    setPuterError(null);
    setPuterResult(null);
    setPuterSaveMessage(null);
    setPuterTokenProgress({ estimatedOutputTokens: 0, isExact: false });
    try {
      const sourceUrl = target.previewUrl || '';
      if (
        target.storageUrl.startsWith('blob:') &&
        target.thumbnailUrl &&
        sourceUrl === target.thumbnailUrl
      ) {
        throw new Error('The original image bytes are no longer available for this local evidence record. Re-upload the original image.');
      }
      const file = await loadOriginalImageFile(sourceUrl, target.fileName, target.mimeType);
      const result = await analyzeWithPuterAI(
        file,
        target.investigationId,
        target.id,
        selectedPuterModel,
        target.sha256Hash,
        timeoutController.signal,
        (progress) => {
          if (requestId === puterRequestId.current && activeItem?.id === target.id) {
            setPuterTokenProgress(progress);
          }
        },
      );
      if (requestId !== puterRequestId.current || activeItem?.id !== target.id) return;

      setPuterResult(result);
      const observationSummary = result.observations.length
        ? result.observations.map((observation) =>
          `${observation.title}: ${observation.explanation} [${observation.evidenceLevel}; affected region: ${observation.affectedRegion || 'not identified'}]`
        ).join('\n')
        : 'No image-specific visual observations were supported by the model.';
      try {
        const saveStatus = await savePuterImageDetectionResult(result);
        if (requestId === puterRequestId.current && activeItem?.id === target.id) {
          setPuterSaveMessage(saveStatus.message);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (requestId === puterRequestId.current && activeItem?.id === target.id) {
          setPuterSaveMessage(detail);
        }
      }

      onAddFinding({
        investigationId: target.investigationId,
        evidenceId: target.id,
        title: `AI Image Detection: ${puterAssessmentLabels[result.assessment]}`,
        severity: 'inconclusive',
        category: 'synthetic_deepfake',
        observedEvidence: `Puter returned the category "${result.assessment}". ${result.observations.length} image-specific observation(s) were reported. Original image SHA-256: ${result.sha256}.\n${observationSummary}`,
        simpleExplanation: `${puterAssessmentLabels[result.assessment]}. This is an experimental visual assessment and does not prove image origin.`,
        technicalExplanation: [
          `Model: ${result.modelName} (${result.modelId}; ${result.modelVersion}). Provider: ${result.provider} via Puter.`,
          `Analyzed: ${result.timestamp}. Image: ${result.fileName}, ${result.mimeType}, ${result.width} × ${result.height}px.`,
          `Original image SHA-256: ${result.sha256}. Assessment category: ${result.assessment}.`,
          `Request usage: input ${result.usage.inputTokens ?? 'not provided'} tokens; output ${result.usage.outputTokens ?? 'not provided'} tokens; cost ${result.usage.costMicrocents === undefined ? 'not provided' : `${result.usage.costMicrocents} microcents`}.`,
          `Image-specific observations:\n${observationSummary}`,
        ].join('\n'),
        detectionMethod: 'AI Image Detection (Puter.js visual model)',
        detectorVersion: result.modelVersion,
        sourceSha256: result.sha256,
        evidenceLabel: 'model_prediction',
        methodReliability: 'Experimental general-purpose vision-language-model opinion; not a validated forensic detector and not proof of origin.',
        potentialFalsePositives: 'Compression, resizing, post-processing, lighting, and ordinary photographic artifacts may resemble synthetic visual cues.',
        unresolvedQuestions: 'Visual inspection cannot establish whether the image is original, AI-generated, or edited.',
        recommendedNextSteps: 'Preserve the original evidence file and consider independent metadata, Content Credentials, and specialist forensic review.',
        limitations: result.limitations.join(' '),
      });
    } catch (error) {
      if (requestId === puterRequestId.current && activeItem?.id === target.id) {
        const isTimeout = timeoutController.signal.aborted ||
          (error instanceof DOMException && error.name === 'TimeoutError');
        setPuterError(isTimeout
          ? 'The analysis timed out. No result was produced; try again.'
          : error instanceof Error ? error.message : formatPuterError(error));
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === puterRequestId.current && activeItem?.id === target.id) {
        setPuterLoading(false);
      }
      if (isPuterSignedIn()) {
        void getPuterMonthlyUsage()
          .then((usage) => {
            setPuterUsage(usage);
            setPuterUsageError(null);
          })
          .catch(() => setPuterUsageError('Usage information currently unavailable.'));
      }
    }
  };

  const handleConnectPuter = async () => {
    setPuterConnectLoading(true);
    setPuterError(null);
    try {
      await connectPuterAccount();
      const signedIn = isPuterSignedIn();
      setPuterSignedIn(signedIn);
      if (!signedIn) throw new Error('Puter sign-in did not complete. Please try again.');
    } catch (error) {
      setPuterError(formatPuterError(error));
    } finally {
      setPuterConnectLoading(false);
    }
  };

  const handleSwitchPuterAccount = async () => {
    setPuterConnectLoading(true);
    setPuterError(null);
    setPuterAccountMessage(null);
    setPuterResult(null);
    setPuterConsent(false);
    setPuterSaveMessage(null);
    setPuterTokenProgress(null);
    try {
      await requestPuterAccountSwitch();
      const signedIn = isPuterSignedIn();
      setPuterSignedIn(signedIn);
      if (!signedIn) throw new Error('Puter sign-in did not complete. Please try again.');
      setPuterModelsRefreshKey((key) => key + 1);
      setPuterUsageRefreshKey((key) => key + 1);
      setPuterAccountMessage('Puter sign-in completed. Confirm the account in the sign-in window.');
    } catch (error) {
      setPuterError(formatPuterError(error));
    } finally {
      setPuterConnectLoading(false);
    }
  };

  const runContrastiveDeepfakeDetection = async () => {
    if (!activeItem || contrastiveDeepfakeLoading) return;
    const target = activeItem;
    const requestId = ++contrastiveDeepfakeRequestId.current;
    setContrastiveDeepfakeLoading(true);
    setContrastiveDeepfakeError(null);
    setContrastiveDeepfakeResult(null);

    try {
      const sourceUrl = target.previewUrl || '';
      if (
        target.storageUrl.startsWith('blob:') &&
        target.thumbnailUrl &&
        sourceUrl === target.thumbnailUrl
      ) {
        throw new Error('The original image bytes are no longer available. Re-upload the original image.');
      }
      const file = await loadOriginalImageFile(sourceUrl, target.fileName, target.mimeType);
      const result = await analyzeContrastiveDeepfake(file);
      if (requestId !== contrastiveDeepfakeRequestId.current || activeItem?.id !== target.id) return;

      setContrastiveDeepfakeResult(result);
      if (result.assessment !== 'no_face_detected' && result.fake_score !== null) {
        const scorePercent = (result.fake_score * 100).toFixed(1);
        onAddFinding({
          investigationId: target.investigationId,
          evidenceId: target.id,
          title: `Face Deepfake Detection: ${result.label}`,
          severity: 'inconclusive',
          category: 'synthetic_deepfake',
          observedEvidence: `The ${result.model_id} model returned an uncalibrated fake-class score of ${scorePercent}% for the largest detected face at x=${result.face?.x}, y=${result.face?.y}, width=${result.face?.width}, height=${result.face?.height}.`,
          simpleExplanation: `${result.label}. This local model score is only a signal for review; it does not prove that the image is fake or real.`,
          technicalExplanation: [
            `Model: ${result.model_id}. Fake-class softmax output: ${result.fake_score}. Classification threshold: 0.5.`,
            `Detected face region: ${JSON.stringify(result.face)}.`,
            `Model source: ${result.model_url}.`,
            ...result.limitations,
          ].join('\n'),
          detectionMethod: 'Contrastive EfficientNet-B4 face deepfake detector',
          detectorVersion: result.model_id,
          evidenceLocation: result.face
            ? {
                x: result.face.x,
                y: result.face.y,
                width: result.face.width,
                height: result.face.height,
                label: 'Largest detected face',
              }
            : undefined,
          rawDetectorScore: result.fake_score,
          scoreInterpretation: 'Uncalibrated softmax output for the model’s fake class; it is not a probability of authenticity.',
          evidenceLabel: 'model_prediction',
          sourceSha256: target.sha256Hash,
          methodReliability: 'Research model evaluated on specific held-out face-forgery datasets; performance on other sources and face-cropping differences is unknown.',
          potentialFalsePositives: 'Compression, image resizing, face-crop differences, and content outside the model’s training distribution may affect the score.',
          unresolvedQuestions: 'The model does not establish image provenance, authorship, or whether the image was AI-generated as a whole.',
          recommendedNextSteps: 'Preserve the original image and compare this signal with independent provenance and forensic evidence.',
          limitations: result.limitations.join(' '),
        });
      }
    } catch (error) {
      if (requestId === contrastiveDeepfakeRequestId.current && activeItem?.id === target.id) {
        setContrastiveDeepfakeError(error instanceof Error ? error.message : 'Local face deepfake analysis failed.');
      }
    } finally {
      if (requestId === contrastiveDeepfakeRequestId.current && activeItem?.id === target.id) {
        setContrastiveDeepfakeLoading(false);
      }
    }
  };

  const runVideoScan = async (item?: EvidenceItem) => {
    const target = item || activeVideoItem;
    if (!target) return;
    const requestId = ++videoScanRequestId.current;
    setVideoResult(null);
    setVideoError(null);
    setVideoAnalyzing(true);
    setVideoSavedSuccess(false);
    try {
      const scanResult = await scanVideoDeepfakeForensics(
        target.previewUrl || target.storageUrl || '',
        { samplingIntervalSec: videoSamplingInterval, maxFrames: videoMaxFrames }
      );
      if (requestId === videoScanRequestId.current && activeVideoItem?.id === target.id) {
        setVideoResult(scanResult);
      }
    } catch (err: any) {
      if (requestId === videoScanRequestId.current) {
        setVideoError(err?.message || 'Video scan failed. Check that the file is a supported format (MP4/WebM/MOV).');
      }
    } finally {
      if (requestId === videoScanRequestId.current) setVideoAnalyzing(false);
    }
  };

  const runTruthScanVideoDetection = async () => {
    const target = activeVideoItem;
    if (!target || !truthScanVideoConsent) return;
    const sourceUrl = target.previewUrl || target.storageUrl;
    if (!sourceUrl) {
      setTruthScanVideoError('The selected video has no readable source URL.');
      return;
    }

    const requestId = ++truthScanVideoRequestId.current;
    setTruthScanVideoBusy(true);
    setTruthScanVideoStage('Loading video…');
    setTruthScanVideoError(null);
    setTruthScanVideoResult(null);
    setTruthScanVideoSaved(false);
    try {
      const videoResponse = await fetch(sourceUrl);
      if (!videoResponse.ok) {
        throw new Error(`Could not read the selected video (HTTP ${videoResponse.status}).`);
      }
      const videoBlob = await videoResponse.blob();
      if (videoBlob.size < 1024 || videoBlob.size > 100 * 1024 * 1024) {
        throw new Error('TruthScan accepts videos from 1 KB to 100 MB.');
      }
      if (requestId !== truthScanVideoRequestId.current) return;

      setTruthScanVideoStage('Submitting video to TruthScan…');
      const submitted = await submitTruthScanVideo(videoBlob, target.fileName, truthScanVideoModel);
      let result = submitted;
      const startedAt = Date.now();
      while (result.status !== 'done' && result.status !== 'failed' && Date.now() - startedAt < 6 * 60 * 1000) {
        if (requestId !== truthScanVideoRequestId.current) return;
        setTruthScanVideoStage(`TruthScan status: ${result.status}…`);
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        result = await queryTruthScanVideo(submitted.id);
      }
      if (requestId !== truthScanVideoRequestId.current) return;
      if (result.status === 'failed') {
        throw new Error('TruthScan could not process this video. Check the file and try again.');
      }
      if (result.status !== 'done') {
        throw new Error('TruthScan is still processing this video. Wait a little and retry the status check.');
      }
      setTruthScanVideoResult(result);
    } catch (error) {
      if (requestId === truthScanVideoRequestId.current) {
        const message = error instanceof Error ? error.message : 'TruthScan video detection failed.';
        if (/credit|balance|quota/i.test(message)) {
          const credits = await refreshTruthScanVideoCredits();
          const balanceMessage = credits
            ? ` The configured video key has ${credits.credits.toLocaleString()} credits, but TruthScan says this particular request exceeds the available balance.`
            : '';
          setTruthScanVideoError(
            `${message}${balanceMessage} TruthScan does not return the required credit cost. Check the video API account’s pricing/balance, or try a smaller video or a shorter clip.`
          );
        } else {
          setTruthScanVideoError(message);
        }
      }
    } finally {
      if (requestId === truthScanVideoRequestId.current) {
        setTruthScanVideoBusy(false);
        setTruthScanVideoStage('');
      }
    }
  };

  const handleSaveTruthScanVideoFinding = () => {
    if (!truthScanVideoResult || !activeVideoItem) return;
    const presentation = getTruthScanVideoPresentation(truthScanVideoResult);
    const normalizedVerdict = presentation.verdict.toLowerCase().replace(/[\s-]+/g, '_');
    const isAiGenerated = ['ai_generated', 'fake', 'synthetic', 'deepfake'].some((term) =>
      normalizedVerdict.includes(term)
    );
    const isReal = ['real', 'authentic', 'human', 'no_detection'].some((term) =>
      normalizedVerdict.includes(term)
    );
    let severity: AnalysisFinding['severity'];
    if (presentation.aiLikelihoodPercent !== null) {
      severity = presentation.aiLikelihoodPercent >= 75
        ? 'critical'
        : presentation.aiLikelihoodPercent >= 50
          ? 'high'
          : 'nominal';
    } else if (isAiGenerated) {
      severity = 'critical';
    } else if (isReal) {
      severity = 'nominal';
    } else {
      severity = 'inconclusive';
    }

    onAddFinding({
      investigationId: activeVideoItem.investigationId,
      evidenceId: activeVideoItem.id,
      title: `TruthScan AI video detection: ${presentation.verdict.replace(/_/g, ' ')}`,
      severity,
      category: 'synthetic_deepfake',
      observedEvidence: `TruthScan verdict: "${presentation.verdict}". ${presentation.aiLikelihoodPercent !== null
        ? `AI likelihood: ${presentation.aiLikelihoodPercent.toFixed(1)}%.`
        : presentation.providerScore !== null
          ? `Provider score: ${presentation.providerScore.toFixed(2)} (provider scale not specified).`
          : 'No numeric score was returned.'} Final stage: ${presentation.finalStage}. Job ID: ${truthScanVideoResult.id}.`,
      simpleExplanation: presentation.aiLikelihoodPercent !== null
        ? `TruthScan reported ${presentation.aiLikelihoodPercent.toFixed(1)}% AI likelihood for this video.`
        : `TruthScan returned the verdict "${presentation.verdict}". The provider did not identify a calibrated AI-likelihood percentage.`,
      technicalExplanation: `TruthScan AI video detector (${truthScanVideoModel} model). ${presentation.framesAnalyzed ?? 'Frame count not reported'} frames analyzed; provider verdict: ${presentation.verdict}; final stage: ${presentation.finalStage}.`,
      detectionMethod: 'TruthScan AI Video Detector API',
      detectorVersion: 'TruthScan API',
      limitations: 'External automated detection is probabilistic and should be interpreted with other forensic evidence.',
    });
    setTruthScanVideoSaved(true);
    setTimeout(() => setTruthScanVideoSaved(false), 3500);
  };

  const handleSaveVideoFinding = () => {
    if (!videoResult || !activeVideoItem) return;
    const isManipu = videoResult.facialDeepfakeVerdict === 'manipulation_indicated' ||
      videoResult.generalAiVideoVerdict === 'synthetic_video_supported';
    const sev: AnalysisFinding['severity'] = isManipu ? 'critical'
      : videoResult.facialDeepfakeVerdict === 'inconclusive' ? 'high' : 'nominal';

    onAddFinding({
      investigationId: activeVideoItem.investigationId,
      evidenceId: activeVideoItem.id,
      title: `Video AI Detection: ${videoResult.generalAiVideoVerdict.replace(/_/g, ' ')}`,
      severity: sev,
      category: 'synthetic_deepfake',
      observedEvidence: `${videoResult.framesAnalyzed} frames sampled at ${videoResult.samplingIntervalSec}s intervals. Facial verdict: ${videoResult.facialDeepfakeVerdict}. AI video verdict: ${videoResult.generalAiVideoVerdict}. Audio sync: ${videoResult.audioSync?.syncVerdict ?? 'N/A'}. Timeline events: ${videoResult.timelineEvents.length}.`,
      simpleExplanation: `Video forensics scanned ${videoResult.framesAnalyzed} keyframes across ${videoResult.videoDurationSec}s of footage. ${isManipu ? 'Temporal boundary anomalies consistent with AI video synthesis or deepfake manipulation were detected.' : 'No significant temporal manipulation indicators found.'}`,
      technicalExplanation: `Temporal keyframe coherence: sampled every ${videoResult.samplingIntervalSec}s. Facial boundary seam analysis across ${videoResult.framesAnalyzed} frames. Audio-video sync lag: ${videoResult.audioSync ? `${videoResult.audioSync.estimatedLagMs}ms (correlation ${videoResult.audioSync.correlationCoefficient})` : 'N/A'}. Timeline anomalies: ${videoResult.timelineEvents.length} events flagged.`,
      detectionMethod: videoResult.modelNamesUsed[0] || 'VexaLens Video Scanner',
      detectorVersion: 'v1.8',
      limitations: videoResult.limitations.join(' '),
    });
    setVideoSavedSuccess(true);
    setTimeout(() => setVideoSavedSuccess(false), 3500);
  };

  if (!activeItem) {
    return (
      <div className="p-8 text-center bg-slate-950 border border-slate-800 rounded-xl max-w-xl mx-auto my-12">
        <BrainCircuit className="w-12 h-12 text-slate-600 mx-auto mb-3" />
        <h3 className="text-lg font-medium text-slate-200">No Image Evidence Selected</h3>
        <p className="text-sm text-slate-400 mt-1">
          Upload photographic evidence in the Evidence Intake view to run AI Image Detection.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Quick Launch Banner to Deepfake Lab */}
      {onNavigateTab && (
        <div className="p-4 rounded-xl border border-cyan-500/40 bg-gradient-to-r from-cyan-950/80 via-slate-900 to-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-lg shadow-cyan-950/20">
          <div className="flex items-center gap-3">
            <span className="p-2.5 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
              <ScanEye className="w-5 h-5 text-cyan-400" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-sm">Advanced AI Video & Deepfake Lab Available</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-400 text-slate-950 uppercase">PRO MODULE</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Examine temporal video keyframe coherence, facial boundary seams, audio-video sync lag, and C2PA Content Credentials.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateTab('deepfake')}
            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition shadow-md shrink-0"
          >
            Launch Deepfake Lab →
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800 text-[11px]">
        <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="text-slate-300 font-semibold">AI IMAGE DETECTION</span>
        <span className="text-slate-500">AI-powered visual review of this evidence image; appearance cannot prove its origin.</span>
      </div>

      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <BrainCircuit className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-100 tracking-tight">AI Image Detection</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Review visual cues with an AI model
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {activeTab === 'origin' && (
            <button
              onClick={() => void runPuterAssessment()}
              disabled={!puterConsent || !puterAvailable || !puterSignedIn || puterLoading}
              className="flex items-center gap-2 px-3.5 py-1.5 bg-cyan-950/80 hover:bg-cyan-900/90 text-cyan-200 border border-cyan-800/80 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${puterLoading ? 'animate-spin text-cyan-400' : ''}`} />
              {puterLoading ? 'Analyzing...' : 'Analyze Image'}
            </button>
          )}
        </div>
      </div>

      {/* Forensic tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
        <button
          onClick={() => setActiveTab('origin')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${activeTab === 'origin'
              ? 'bg-cyan-950 text-cyan-300 border border-cyan-700 shadow-[0_0_12px_rgba(88,215,223,0.2)]'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
            }`}
        >
          <BrainCircuit className="w-4 h-4 text-cyan-400" />
          <span>AI Image Detection</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-900 text-slate-300 border border-slate-700">
            Puter Vision
          </span>
        </button>

        {/* ── NEW: Video AI Detection Tab ── */}
        <button
          onClick={() => setActiveTab('video')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${activeTab === 'video'
              ? 'bg-violet-950 text-violet-300 border border-violet-700 shadow-[0_0_12px_rgba(139,92,246,0.3)]'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
            }`}
        >
          <Film className="w-4 h-4 text-violet-400" />
          <span>Video AI Detection</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-violet-950 text-violet-400 border border-violet-800">
            {videoEvidence.length > 0 ? `${videoEvidence.length} file${videoEvidence.length > 1 ? 's' : ''}` : 'Upload video'}
          </span>
        </button>
      </div>

      {/* Evidence Carousel / Switcher */}
      {imageEvidence.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider shrink-0 pl-1">
            Active Evidence:
          </span>
          {imageEvidence.map((item) => {
            const isSel = item.id === activeItem.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectEvidence(item)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 transition-all ${isSel
                    ? 'bg-cyan-950/50 text-cyan-200 border-cyan-700 shadow-[inset_0_1px_0_rgba(88,215,223,0.3)]'
                    : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
                  }`}
              >
                {item.thumbnailUrl ? (
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-5 h-5 rounded object-cover border border-slate-700"
                  />
                ) : (
                  <span className="w-5 h-5 rounded bg-slate-800" aria-hidden="true" />
                )}
                <span className="truncate max-w-[140px]">{item.fileName}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* TAB 1: Puter-powered AI Image Detection */}
      {activeTab === 'origin' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.8fr)]">
          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100">AI IMAGE DETECTION</h2>
                <p className="mt-1 text-xs text-slate-400">
                  AI-powered analysis to examine whether this image may be AI-generated or captured using a camera.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
                  puterSignedIn
                    ? 'border-emerald-800 bg-emerald-950/50 text-emerald-200'
                    : 'border-amber-800 bg-amber-950/40 text-amber-200'
                }`}>
                  Puter {puterSignedIn ? 'Connected' : 'Not connected'}
                </span>
                {puterSignedIn && (
                  <button
                    type="button"
                    onClick={() => void handleSwitchPuterAccount()}
                    disabled={!puterAvailable || puterConnectLoading || puterLoading}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${puterConnectLoading ? 'animate-spin' : ''}`} />
                    {puterConnectLoading ? 'Opening sign-in…' : 'Switch Puter account'}
                  </button>
                )}
              </div>
            </div>
            {puterAccountMessage && (
              <p role="status" className="text-[11px] text-slate-400">{puterAccountMessage}</p>
            )}

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                <img
                  src={activeItem.previewUrl || activeItem.thumbnailUrl}
                  alt={`Original evidence ${activeItem.fileName}`}
                  className="max-h-80 w-full bg-black object-contain"
                />
                <div className="space-y-1 border-t border-slate-800 p-3 text-[11px] text-slate-400">
                  <p className="break-all font-medium text-slate-200">{activeItem.fileName}</p>
                  <p>{activeItem.metadata.dimensions
                    ? `${activeItem.metadata.dimensions.width} × ${activeItem.metadata.dimensions.height} px`
                    : 'Dimensions unavailable until the original is decoded'}</p>
                  <p>{activeItem.mimeType || 'Image format unavailable'}</p>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm leading-relaxed text-slate-300">
                  The model examines the actual image bytes and reports visible details only. Its result is an experimental assessment, not proof.
                </p>

                {!puterAvailable && (
                  <p role="status" className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-200">
                    Puter.js is unavailable. Check your internet connection and reload the app.
                  </p>
                )}

                {!puterSignedIn && (
                  <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                    <p className="text-xs text-slate-300">
                      Connect your Puter account. Your account is used for the AI request; no VexaLens API key is required.
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleConnectPuter()}
                      disabled={!puterAvailable || puterConnectLoading}
                      className="rounded-lg border border-cyan-700 bg-cyan-950/70 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50"
                    >
                      {puterConnectLoading ? 'Connecting…' : 'Connect to Puter'}
                    </button>
                  </div>
                )}

                <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <label htmlFor="puter-image-model" className="block text-xs font-medium text-slate-200">
                    Choose an image model
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <select
                      id="puter-image-model"
                      value={selectedPuterModelId}
                      onChange={(event) => {
                        setSelectedPuterModelId(event.target.value);
                        setPuterResult(null);
                      }}
                      disabled={puterModelsLoading || puterModels.length === 0 || puterLoading}
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
                    >
                      {puterModelsLoading && <option value="">Loading available models…</option>}
                      {!puterModelsLoading && puterModels.length === 0 && <option value="">No image models available</option>}
                      {puterModels.map((model) => {
                        const provider = model.provider.toLowerCase();
                        const providerLabel = provider === 'google'
                          ? 'Google Gemini'
                          : provider === 'openai'
                            ? 'OpenAI'
                            : 'Claude';
                        return (
                          <option key={model.modelId} value={model.modelId}>
                            {providerLabel} · {model.name}
                            {model.imageInputSupport === 'unknown' ? ' · image support unconfirmed' : ''}
                          </option>
                        );
                      })}
                    </select>
                    <button
                      type="button"
                      onClick={() => setPuterModelsRefreshKey((key) => key + 1)}
                      disabled={puterModelsLoading}
                      className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-50"
                    >
                      {puterModelsLoading ? 'Loading…' : 'Refresh models'}
                    </button>
                  </div>
                  {puterModelsError && (
                    <p role="alert" className="text-[11px] text-amber-200">{puterModelsError}</p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    Models are loaded from your Puter account.{' '}
                    <a
                      href="https://developer.puter.com/tutorials/free-unlimited-image-recognition-api/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                    >
                      Puter image recognition documentation
                    </a>
                  </p>
                </div>

                <label className="flex items-start gap-2 rounded-lg border border-amber-800/70 bg-amber-950/20 p-3 text-xs text-amber-100">
                  <input
                    type="checkbox"
                    checked={puterConsent}
                    onChange={(event) => {
                      setPuterConsent(event.target.checked);
                      setPuterError(null);
                      if (!event.target.checked) setPuterResult(null);
                    }}
                    className="mt-0.5 accent-cyan-400"
                  />
                  <span>
                    I consent to send the original, unmodified image file to Puter for external visual analysis. Puter may process it under its own service policies.
                  </span>
                </label>
                <p className="text-[11px] text-slate-500">
                  The original evidence is not resized or overwritten. A temporary file wrapper preserves its bytes for upload.
                </p>

                <button
                  type="button"
                  onClick={() => void runPuterAssessment()}
                  disabled={!puterConsent || !puterAvailable || !puterSignedIn || !selectedPuterModel || puterModelsLoading || puterLoading}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {puterLoading ? 'Analyzing image…' : puterResult ? 'Re-analyze Image' : 'Analyze Image'}
                </button>

                {puterLoading && (
                  <p role="status" className="text-xs text-cyan-300">
                    The selected image is being examined by the chosen Puter vision model. This may take up to 90 seconds.
                  </p>
                )}
                {puterError && (
                  <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
                    {puterError}
                  </p>
                )}
                {puterSaveMessage && (
                  <p role="status" className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300">
                    {puterSaveMessage}
                  </p>
                )}
              </div>
            </div>

            {puterResult && (
              <div className={`space-y-4 rounded-lg border p-4 ${
                puterResult.assessment === 'possible_ai_generated' ||
                puterResult.assessment === 'possible_ai_assisted_editing'
                  ? 'border-rose-800/70 bg-rose-950/20'
                  : puterResult.assessment === 'camera_consistent'
                    ? 'border-emerald-800/70 bg-emerald-950/20'
                    : 'border-amber-800/70 bg-amber-950/20'
              }`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Simple result</span>
                    <p className={`mt-1 inline-flex rounded-lg border px-3 py-2 text-base font-bold ${
                      puterSimpleResults[puterResult.assessment].style
                    }`}>
                      {puterSimpleResults[puterResult.assessment].label}
                    </p>
                    <h3 className="mt-1 text-lg font-bold text-slate-100">
                      {puterAssessmentLabels[puterResult.assessment]}
                    </h3>
                    <p className="mt-1 text-xs text-slate-300">
                      {puterResult.assessment === 'possible_ai_generated'
                        ? 'Some visual characteristics may be consistent with AI-generated imagery. Further examination is recommended.'
                        : puterResult.assessment === 'camera_consistent'
                          ? 'The visible details appear more consistent with an ordinary photograph. This does not prove that the image is original or unedited.'
                          : puterResult.assessment === 'possible_ai_assisted_editing'
                            ? 'Some parts of the image may have been generated or modified using AI tools.'
                            : 'The available visual evidence is not sufficient to make a useful assessment.'}
                    </p>
                  </div>
                  <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-[10px] font-semibold text-slate-300">
                    {puterResult.processingStatus}
                  </span>
                </div>

                <section aria-labelledby="puter-image-observations" className="space-y-2">
                  <h4 id="puter-image-observations" className="text-xs font-semibold text-slate-200">
                    What the model noticed ({puterResult.observations.length})
                  </h4>
                  {puterResult.observations.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {puterResult.observations.map((observation, index) => (
                        <article key={`${observation.title}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/80 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <h5 className="text-xs font-semibold text-slate-100">{observation.title}</h5>
                            <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[9px] text-cyan-200">
                              {observation.evidenceLevel}
                            </span>
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{observation.explanation}</p>
                          <p className="mt-2 text-[10px] text-slate-500">
                            Affected area: {observation.affectedRegion || 'Not specifically identified'}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">The model did not report specific image details.</p>
                  )}
                </section>
                <p className="text-[10px] text-slate-500">
                  Observation strength describes support for a visible detail, not the likelihood that the image is AI-generated.
                </p>

                <dl className="grid gap-x-4 gap-y-2 border-t border-slate-800 pt-3 text-[11px] sm:grid-cols-2">
                  <div><dt className="text-slate-500">Model</dt><dd className="break-all text-slate-200">{puterResult.modelName} ({puterResult.modelId})</dd></div>
                  <div><dt className="text-slate-500">Provider</dt><dd className="text-slate-200">{puterResult.provider} via Puter</dd></div>
                  <div><dt className="text-slate-500">Analysis time</dt><dd className="text-slate-200">{new Date(puterResult.timestamp).toLocaleString()}</dd></div>
                  <div><dt className="text-slate-500">Image</dt><dd className="break-all text-slate-200">{puterResult.fileName} · {puterResult.width} × {puterResult.height} px</dd></div>
                  <div className="sm:col-span-2"><dt className="text-slate-500">Original SHA-256</dt><dd className="break-all font-mono text-slate-300">{puterResult.sha256}</dd></div>
                  <div><dt className="text-slate-500">Input tokens</dt><dd className="text-slate-200">{puterResult.usage.inputTokens ?? 'Not provided by Puter'}</dd></div>
                  <div><dt className="text-slate-500">Output tokens</dt><dd className="text-slate-200">{puterResult.usage.outputTokens ?? 'Not provided by Puter'}</dd></div>
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">Actual request cost</dt>
                    <dd className="text-slate-200">
                      {puterResult.usage.costMicrocents === undefined
                        ? 'Not provided by Puter'
                        : formatPuterMicrocents(puterResult.usage.costMicrocents)}
                    </dd>
                  </div>
                </dl>
                <ul className="list-disc space-y-1 border-t border-slate-800 pt-3 pl-5 text-[11px] text-slate-400">
                  {puterResult.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
                </ul>
              </div>
            )}

            <p className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs leading-relaxed text-slate-300">
              AI image detection is an experimental forensic assessment. Visual characteristics alone cannot prove whether an image is AI-generated or authentic.
            </p>
          </section>

          <section className="h-fit space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold tracking-wide text-slate-100">PUTER AI USAGE</h2>
                <p className="mt-1 text-[11px] text-slate-500">Allowance and application usage from your Puter account</p>
              </div>
              {puterSignedIn && (
                <button
                  type="button"
                  onClick={() => {
                    setPuterUsageLoading(true);
                    setPuterUsageError(null);
                    void getPuterMonthlyUsage()
                      .then(setPuterUsage)
                      .catch(() => {
                        setPuterUsage(null);
                        setPuterUsageError('Usage information currently unavailable.');
                      })
                      .finally(() => setPuterUsageLoading(false));
                  }}
                  disabled={puterUsageLoading}
                  className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[10px] text-slate-300 disabled:opacity-50"
                >
                  {puterUsageLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
            </div>

            {!puterSignedIn && (
              <p className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-400">
                Connect your Puter account to view allowance and usage.
              </p>
            )}
            {puterUsageLoading && (
              <p role="status" className="text-xs text-cyan-300">Loading current Puter usage…</p>
            )}
            {puterUsageError && (
              <p role="status" className="text-xs text-amber-300">{puterUsageError}</p>
            )}
            {(puterLoading || puterTokenProgress) && (
              <p role="status" className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-cyan-200">
                {puterTokenProgress?.isExact
                  ? `Puter-reported tokens: input ${puterTokenProgress.inputTokens ?? 'not provided'} · output ${puterTokenProgress.outputTokens ?? 'not provided'}.`
                  : puterLoading
                    ? `Live output-token estimate: ${puterTokenProgress?.estimatedOutputTokens ?? 0} (approximate; based on streamed text).`
                    : `Output-token estimate: ${puterTokenProgress?.estimatedOutputTokens ?? 0}. Puter did not provide exact token totals.`}
              </p>
            )}
            {puterUsage && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                    <span className="block text-[10px] uppercase text-slate-500">Remaining monthly allowance</span>
                    <strong className="mt-1 block text-sm text-cyan-200">
                      {puterUsage.remainingMicrocents === undefined
                        ? 'Not available'
                        : formatPuterMicrocents(puterUsage.remainingMicrocents)}
                    </strong>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                    <span className="block text-[10px] uppercase text-slate-500">Monthly allowance</span>
                    <strong className="mt-1 block text-sm text-slate-200">
                      {puterUsage.allowanceMicrocents === undefined
                        ? 'Not available'
                        : formatPuterMicrocents(puterUsage.allowanceMicrocents)}
                    </strong>
                  </div>
                </div>
                <div className="space-y-1 text-[11px] text-slate-400">
                  <p>Resources used: {puterUsage.usedMicrocents === undefined
                    ? 'Not available'
                    : formatPuterMicrocents(puterUsage.usedMicrocents)}</p>
                  <p>Allowance used: {puterUsage.usedMicrocents === undefined || !puterUsage.allowanceMicrocents
                    ? 'Not available'
                    : `${((puterUsage.usedMicrocents / puterUsage.allowanceMicrocents) * 100).toFixed(1)}%`}</p>
                  <p>AI request count: {puterUsage.aiRequestCount ?? 'Not provided'}</p>
                  <p>Application request count: {puterUsage.appRequestCount ?? 'Not provided'}</p>
                  <p>Application resources: {puterUsage.appResourcesMicrocents === undefined
                    ? 'Not provided'
                    : `$${(puterUsage.appResourcesMicrocents / 100_000_000).toFixed(4)}`}</p>
                  <p>Last refreshed: {new Date(puterUsage.refreshedAt).toLocaleTimeString()}</p>
                </div>
                {puterUsage.apiUsage.length > 0 && (
                  <details className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-300">Usage breakdown</summary>
                    <ul className="mt-2 space-y-1 text-[10px] text-slate-400">
                      {puterUsage.apiUsage.slice(0, 8).map((usage) => (
                        <li key={usage.name} className="flex justify-between gap-2">
                          <span className="break-all">{usage.name}</span>
                          <span className="shrink-0 text-right">
                            {usage.count ?? '—'} requests
                            {usage.costMicrocents === undefined
                              ? ''
                              : ` · ${formatPuterMicrocents(usage.costMicrocents)}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="text-[10px] text-slate-500">
                  Per-API usage may take about one minute to update. Allowance used is the portion already consumed, not the remaining percentage. Amounts show up to eight decimals. Puter controls account funding and model access; VexaLens cannot add funds.
                </p>
              </div>
            )}
          </section>

        </div>
      )}

      {activeTab === 'origin' && (
        <section className="space-y-4 rounded-xl border border-violet-900/60 bg-slate-950 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-100">Local Face Deepfake Detector</h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Runs the Hugging Face EfficientNet-B4 face-forgery model on the local VexaLens backend.
                The first face scan downloads its approximately 141 MB checkpoint. The image is not sent to an inference provider.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runContrastiveDeepfakeDetection()}
              disabled={contrastiveDeepfakeLoading}
              className="shrink-0 rounded-lg border border-violet-700 bg-violet-950/70 px-4 py-2 text-xs font-semibold text-violet-100 hover:bg-violet-900/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {contrastiveDeepfakeLoading ? 'Running local model…' : 'Run local face scan'}
            </button>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            This research model is for manipulated face images, not general AI-generated images. It analyzes the largest
            face detected in the image; no face means no verdict. Its score is uncalibrated and cannot prove that an image
            is real or fake. This scan uses the RetinaFace face detector described by the model card; its score can still
            miss face swaps.
          </p>

          {contrastiveDeepfakeLoading && (
            <p role="status" className="text-xs text-violet-200">
              Loading the model if needed and analyzing the largest detected face. The first face scan may take several minutes.
            </p>
          )}
          {contrastiveDeepfakeError && (
            <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
              {contrastiveDeepfakeError}
            </p>
          )}
          {contrastiveDeepfakeResult && (
            <div className={`space-y-3 rounded-lg border p-4 ${
              contrastiveDeepfakeResult.assessment === 'possible_deepfake'
                ? 'border-rose-800/70 bg-rose-950/20'
                : contrastiveDeepfakeResult.assessment === 'no_face_detected'
                  ? 'border-amber-800/70 bg-amber-950/20'
                  : 'border-slate-700 bg-slate-900/60'
            }`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Simple result</p>
                  <h3 className="mt-1 text-base font-bold text-slate-100">{contrastiveDeepfakeResult.label}</h3>
                </div>
                {contrastiveDeepfakeResult.fake_score !== null && (
                  <p className="text-right">
                    <span className="block text-[10px] text-slate-400">Uncalibrated model fake score</span>
                    <strong className="text-lg text-slate-100">
                      {(contrastiveDeepfakeResult.fake_score * 100).toFixed(1)}%
                    </strong>
                  </p>
                )}
              </div>
              {contrastiveDeepfakeResult.face && (
                <p className="text-xs text-slate-300">
                  Largest detected face: x={contrastiveDeepfakeResult.face.x}, y={contrastiveDeepfakeResult.face.y},
                  {' '}{contrastiveDeepfakeResult.face.width} × {contrastiveDeepfakeResult.face.height}px.
                </p>
              )}
              <ul className="list-disc space-y-1 border-t border-slate-700/70 pt-3 pl-5 text-[11px] text-slate-400">
                {contrastiveDeepfakeResult.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
              </ul>
              <a
                href={contrastiveDeepfakeResult.model_url}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[11px] text-violet-300 underline underline-offset-2 hover:text-violet-200"
              >
                Hugging Face model card
              </a>
            </div>
          )}
        </section>
      )}

      {/* TAB 4: Video AI Detection                            */}
      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {activeTab === 'video' && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-violet-950/20 border border-violet-800/50">
            <div className="flex items-center gap-3">
              <span className="p-2.5 rounded-lg bg-violet-950/60 border border-violet-700/60 text-violet-400">
                <Film className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  Video AI Detection &amp; Deepfake Forensics
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500 text-white font-bold uppercase">NEW</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  TruthScan ML detection · Local temporal keyframe analysis · Audio-video sync verification
                </p>
              </div>
            </div>
            <span className="text-[11px] font-mono text-violet-300 bg-violet-950/40 border border-violet-800/60 px-2 py-0.5 rounded shrink-0">
              TruthScan Video API + Local Scanner
            </span>
          </div>

          {/* No video evidence */}
          {videoEvidence.length === 0 ? (
            <div className="p-10 text-center bg-slate-950 border border-dashed border-violet-800/40 rounded-xl space-y-3">
              <Video className="w-12 h-12 text-violet-700 mx-auto" />
              <h3 className="text-base font-semibold text-slate-300">No Video Evidence Loaded</h3>
              <p className="text-sm text-slate-500 max-w-sm mx-auto">
                Upload MP4, WebM, or MOV video files via Evidence Intake to run AI video detection.
              </p>
            </div>
          ) : (
            <>
              {/* Video selector */}
              {videoEvidence.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider shrink-0">Select Video:</span>
                  {videoEvidence.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setActiveVideoItem(v);
                        setVideoResult(null);
                        setVideoError(null);
                      }}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 transition-all ${activeVideoItem?.id === v.id
                          ? 'bg-violet-950/60 text-violet-200 border-violet-700'
                          : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                        }`}
                    >
                      <Film className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[160px]">{v.fileName}</span>
                    </button>
                  ))}
                </div>
              )}

              {activeVideoItem?.previewUrl && (
                <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950 p-4">
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">Video preview</h3>
                    <p className="mt-1 truncate text-xs text-slate-400">{activeVideoItem.fileName}</p>
                  </div>
                  <video
                    key={activeVideoItem.id}
                    src={activeVideoItem.previewUrl}
                    controls
                    preload="metadata"
                    playsInline
                    className="max-h-[65vh] w-full rounded-lg bg-black"
                    aria-label={`Preview of ${activeVideoItem.fileName}`}
                  />
                </section>
              )}
              {activeVideoItem && !activeVideoItem.previewUrl && !activeVideoItem.storageUrl && (
                <div role="status" className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4 text-xs text-amber-200">
                  A preview URL is not available for this evidence item. Refresh or reload the evidence list before submitting it for detection.
                </div>
              )}

              <section className="space-y-3 p-4 rounded-xl bg-slate-950 border border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-slate-100">TruthScan AI video detection</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Submits the selected video to TruthScan for specialist AI-generated-video analysis. Supports MP4, MOV, AVI, MKV, and WebM up to 100 MB.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Video API balance</p>
                    {truthScanVideoCredits ? (
                      <p className="mt-1 text-xs text-emerald-300">
                        {truthScanVideoCredits.credits.toLocaleString()} credits
                        <span className="ml-2 text-slate-500">
                          ({truthScanVideoCredits.baseCredits.toLocaleString()} base + {truthScanVideoCredits.boostCredits.toLocaleString()} boost)
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">Balance not loaded</p>
                    )}
                    {truthScanVideoCreditsError && <p role="alert" className="mt-1 text-xs text-amber-300">{truthScanVideoCreditsError}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshTruthScanVideoCredits()}
                    disabled={truthScanVideoCreditsLoading}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${truthScanVideoCreditsLoading ? 'animate-spin' : ''}`} />
                    {truthScanVideoCreditsLoading ? 'Checking…' : 'Refresh balance'}
                  </button>
                </div>
                <label className="flex items-start gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={truthScanVideoConsent}
                    onChange={(event) => setTruthScanVideoConsent(event.target.checked)}
                    className="mt-0.5"
                    disabled={truthScanVideoBusy}
                  />
                  <span>
                    I consent to sending the full video file to the external TruthScan AI video detection service. Provider processing and retention policies apply.
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-400" htmlFor="truthscan-video-model">Model</label>
                  <select
                    id="truthscan-video-model"
                    value={truthScanVideoModel}
                    onChange={(event) => setTruthScanVideoModel(event.target.value as TruthScanVideoModel)}
                    disabled={truthScanVideoBusy}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="generic">Generic</option>
                    <option value="faceswap">Face Swap</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void runTruthScanVideoDetection()}
                    disabled={!activeVideoItem || !truthScanVideoConsent || truthScanVideoBusy}
                    className="rounded-lg border border-violet-700 bg-violet-950/60 px-3 py-2 text-xs font-semibold text-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {truthScanVideoBusy ? 'Detecting…' : 'Run TruthScan Detection'}
                  </button>
                </div>
                {truthScanVideoBusy && (
                  <p role="status" className="text-xs text-violet-200">{truthScanVideoStage}</p>
                )}
                {truthScanVideoError && (
                  <p role="alert" className="text-xs text-rose-300">{truthScanVideoError}</p>
                )}
                {truthScanVideoResult && (() => {
                  const presentation = getTruthScanVideoPresentation(truthScanVideoResult);
                  return (
                    <div className="space-y-3 rounded-lg border border-violet-800/50 bg-slate-900/60 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-violet-300">TruthScan analysis complete</p>
                          <p className="mt-1 text-lg font-bold text-slate-100">Verdict: {presentation.verdict.replace(/_/g, ' ')}</p>
                          {presentation.aiLikelihoodPercent !== null ? (
                            <p className="text-xs text-slate-300">AI likelihood: {presentation.aiLikelihoodPercent.toFixed(1)}%</p>
                          ) : presentation.providerScore !== null ? (
                            <p className="text-xs text-slate-300">Provider score: {presentation.providerScore.toFixed(2)} <span className="text-slate-500">(scale not specified)</span></p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={handleSaveTruthScanVideoFinding}
                          disabled={truthScanVideoSaved}
                          className="rounded-lg border border-violet-700 bg-violet-950/60 px-3 py-1.5 text-xs font-semibold text-violet-200 disabled:opacity-60"
                        >
                          {truthScanVideoSaved ? 'Finding saved' : 'Save Finding'}
                        </button>
                      </div>
                      <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
                        <p>Final stage: {presentation.finalStage}</p>
                        <p>Watermark: {presentation.watermark}</p>
                        <p>Frames analyzed: {presentation.framesAnalyzed ?? 'Not reported'}</p>
                      </div>
                      <p className="text-[10px] text-slate-500">Job ID: {truthScanVideoResult.id}. TruthScan may return a verdict and provider-specific score instead of an AI-likelihood percentage. Automated results should be considered alongside other forensic evidence.</p>
                    </div>
                  );
                })()}
              </section>

              <section className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-300">Optional local forensic scan</p>
                  <p className="mt-1 text-[10px] text-slate-500">Runs locally in the browser; it does not submit video to an external service.</p>
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Sampling Interval</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0.5" max="3" step="0.5" value={videoSamplingInterval}
                      onChange={(e) => setVideoSamplingInterval(parseFloat(e.target.value))}
                      className="w-28 cursor-pointer accent-violet-400" />
                    <span className="font-mono text-xs text-violet-300">{videoSamplingInterval}s</span>
                  </div>
                  <p className="text-[10px] text-slate-500">between sampled keyframes</p>
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Max Frames</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="4" max="24" step="4" value={videoMaxFrames}
                      onChange={(e) => setVideoMaxFrames(parseInt(e.target.value, 10))}
                      className="w-28 cursor-pointer accent-violet-400" />
                    <span className="font-mono text-xs text-violet-300">{videoMaxFrames}</span>
                  </div>
                  <p className="text-[10px] text-slate-500">frames to analyze</p>
                </div>
                <button
                  id="video-scan-btn"
                  onClick={() => runVideoScan()}
                  disabled={videoAnalyzing || !activeVideoItem}
                  className="ml-auto flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50"
                >
                  {videoAnalyzing
                    ? <><div className="h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-white animate-spin" /> Scanning…</>
                    : <><Play className="h-3.5 w-3.5" /> Run Local Video Scan</>}
                </button>
              </section>

              {/* Error */}
              {videoError && (
                <div className="flex items-start gap-2 p-3 bg-red-950/40 border border-red-700/50 rounded-xl text-xs text-red-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />{videoError}
                </div>
              )}

              {/* Scanning spinner */}
              {videoAnalyzing && (
                <div className="flex flex-col items-center justify-center gap-3 p-10 bg-slate-950 border border-violet-800/30 rounded-xl">
                  <div className="w-12 h-12 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
                  <p className="text-sm text-violet-300 font-mono animate-pulse">Sampling video keyframes &amp; computing temporal coherence…</p>
                  <p className="text-xs text-slate-500">This may take 10–30s depending on video length</p>
                </div>
              )}

              {/* Results */}
              {videoResult && !videoAnalyzing && (() => {
                const isManip = videoResult.facialDeepfakeVerdict === 'manipulation_indicated' ||
                  videoResult.generalAiVideoVerdict === 'synthetic_video_supported';
                const isInconclusive = videoResult.facialDeepfakeVerdict === 'inconclusive' ||
                  videoResult.generalAiVideoVerdict === 'inconclusive';

                return (
                  <div className="space-y-5">
                    {/* Verdict Banner */}
                    <div className={`flex items-start justify-between gap-4 p-4 rounded-xl border bg-gradient-to-r ${isManip ? 'from-rose-950/60 to-slate-950 border-rose-700/60 text-rose-300'
                        : isInconclusive ? 'from-amber-950/40 to-slate-950 border-amber-700/60 text-amber-300'
                          : 'from-emerald-950/40 to-slate-950 border-emerald-700/60 text-emerald-300'
                      }`}>
                      <div className="flex items-start gap-3">
                        {isManip ? <AlertTriangle className="w-5 h-5" /> : isInconclusive ? <HelpCircle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
                        <div>
                          <div className="text-xs font-mono font-bold uppercase tracking-wider opacity-70">
                            Facial: {videoResult.facialDeepfakeVerdict.replace(/_/g, ' ')} · AI Video: {videoResult.generalAiVideoVerdict.replace(/_/g, ' ')}
                          </div>
                          <p className="text-sm font-semibold text-slate-100 mt-0.5">
                            {isManip ? 'Temporal manipulation indicators detected — AI-generated or deepfake video patterns present'
                              : isInconclusive ? 'Inconclusive — some anomalies present; further analysis recommended'
                                : 'No significant AI video manipulation detected — temporal coherence consistent with authentic footage'}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {videoResult.framesAnalyzed} frames · {videoResult.videoDurationSec}s · sampled every {videoResult.samplingIntervalSec}s
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handleSaveVideoFinding}
                        disabled={videoSavedSuccess}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 flex items-center gap-1.5 transition-all ${videoSavedSuccess ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                            : 'bg-violet-950/70 hover:bg-violet-900 text-violet-200 border-violet-800'
                          }`}
                      >
                        {videoSavedSuccess ? <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Saved</> : <><Plus className="w-3.5 h-3.5" /> Save Finding</>}
                      </button>
                    </div>

                    {/* Metrics */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: 'Duration', val: `${videoResult.videoDurationSec}s`, sub: `${videoResult.framesSampled} timestamps`, color: 'text-violet-300' },
                        { label: 'Frames Analyzed', val: videoResult.framesAnalyzed, sub: 'keyframes sampled', color: 'text-cyan-300' },
                        { label: 'Timeline Events', val: videoResult.timelineEvents.length, sub: 'anomalies flagged', color: videoResult.timelineEvents.length > 0 ? 'text-amber-300' : 'text-emerald-300' },
                        ...(videoResult.audioSync ? [{ label: 'Audio Sync Lag', val: `${videoResult.audioSync.estimatedLagMs}ms`, sub: videoResult.audioSync.syncVerdict.replace(/_/g, ' '), color: Math.abs(videoResult.audioSync.estimatedLagMs) > 50 ? 'text-rose-300' : 'text-emerald-300' }] : []),
                      ].map(({ label, val, sub, color }) => (
                        <div key={label} className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                          <span className="text-[10px] text-slate-500 uppercase font-semibold block">{label}</span>
                          <span className={`text-lg font-bold font-mono mt-1 block ${color}`}>{val}</span>
                          <span className="text-[10px] text-slate-400">{sub}</span>
                        </div>
                      ))}
                    </div>

                    {/* Keyframe Strip */}
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Film className="w-3.5 h-3.5 text-violet-400" /> Keyframe Strip
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">{videoResult.framesAnalyzed} frames</span>
                      </div>
                      <div className="flex gap-2 overflow-x-auto pb-2">
                        {videoResult.perFrameResults.map((frame) => {
                          const anomaly = (frame.faceSeamAnomalyScore ?? 0) > 50;
                          return (
                            <div key={frame.frameIndex}
                              className={`shrink-0 rounded-lg overflow-hidden border space-y-1 ${frame.isSceneCut ? 'border-blue-600/60' : anomaly ? 'border-rose-600/80' : 'border-slate-700/60'
                                }`} style={{ width: 110 }}
                            >
                              {frame.dataUrl ? (
                                <img src={frame.dataUrl} alt={`F${frame.frameIndex}`} className="w-full object-cover" style={{ height: 62 }} />
                              ) : (
                                <div className="w-full bg-slate-900 flex items-center justify-center" style={{ height: 62 }}>
                                  <Film className="w-5 h-5 text-slate-600" />
                                </div>
                              )}
                              <div className="px-1.5 pb-1.5 space-y-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono text-slate-400">#{frame.frameIndex}</span>
                                  <span className="text-[10px] font-mono text-violet-400">{frame.formattedTime}</span>
                                </div>
                                <div className={`text-[10px] font-semibold ${anomaly ? 'text-rose-400' : frame.isSceneCut ? 'text-blue-400' : 'text-emerald-400'
                                  }`}>
                                  {frame.isSceneCut ? 'Scene Cut' : anomaly ? `Seam ${(frame.faceSeamAnomalyScore ?? 0).toFixed(0)}` : 'Nominal'}
                                </div>
                                <div className="text-[9px] font-mono text-slate-600 truncate" title={frame.sha256}>
                                  {frame.sha256.substring(0, 8)}…
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-4 text-[10px] text-slate-500 pt-1 border-t border-slate-800/60">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-600" />Nominal</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-rose-600" />Seam Anomaly</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-600" />Scene Cut</span>
                      </div>
                    </div>

                    {/* Audio-Video Sync */}
                    {videoResult.audioSync && (
                      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <AudioLines className="w-4 h-4 text-cyan-400" />
                          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Audio-Video Sync Analysis</span>
                          <span className={`ml-auto text-[11px] px-2 py-0.5 rounded border font-mono ${videoResult.audioSync.syncVerdict === 'nominal_sync'
                              ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                              : 'bg-amber-950/40 border-amber-800 text-amber-300'
                            }`}>{videoResult.audioSync.syncVerdict.replace(/_/g, ' ')}</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div><span className="text-slate-500 block">Audio Track</span><span className="font-mono text-slate-200">{videoResult.audioSync.audioTrackFound ? 'Found' : 'Not Found'}</span></div>
                          <div><span className="text-slate-500 block">Sample Rate</span><span className="font-mono text-slate-200">{((videoResult.audioSync.audioSampleRateHz ?? 0) / 1000).toFixed(0)}kHz</span></div>
                          <div><span className="text-slate-500 block">Sync Lag</span><span className={`font-mono font-semibold ${Math.abs(videoResult.audioSync.estimatedLagMs) > 50 ? 'text-rose-400' : 'text-emerald-400'}`}>{videoResult.audioSync.estimatedLagMs}ms</span></div>
                          <div><span className="text-slate-500 block">Correlation</span><span className="font-mono text-violet-300">{videoResult.audioSync.correlationCoefficient}</span></div>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 p-3 rounded-lg border border-slate-800">{videoResult.audioSync.explanation}</p>
                      </div>
                    )}

                    {/* Timeline Events */}
                    {videoResult.timelineEvents.length > 0 && (
                      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Timer className="w-3.5 h-3.5 text-amber-400" /> Timeline Anomaly Events ({videoResult.timelineEvents.length})
                        </span>
                        <div className="space-y-2">
                          {videoResult.timelineEvents.map((evt) => (
                            <div key={evt.id} className={`flex items-start gap-3 p-3 rounded-lg border text-xs ${evt.severity === 'warning' ? 'bg-amber-950/20 border-amber-800/50' : 'bg-slate-900/60 border-slate-800'
                              }`}>
                              <span className="font-mono text-violet-300 shrink-0">{evt.formattedTime}</span>
                              <div className="space-y-0.5">
                                <span className={`font-semibold ${evt.severity === 'warning' ? 'text-amber-300' : 'text-slate-300'}`}>{evt.label}</span>
                                <p className="text-slate-400">{evt.description}</p>
                              </div>
                              <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded border font-mono ${evt.severity === 'warning' ? 'bg-amber-950 border-amber-700 text-amber-300' : 'bg-slate-900 border-slate-700 text-slate-400'
                                }`}>{evt.severity}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Limitations */}
                    <div className="p-3 bg-amber-950/20 border border-amber-900/40 rounded-lg space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
                        <AlertTriangle className="w-3.5 h-3.5" /> Forensic Scope &amp; Limitations
                      </div>
                      <ul className="space-y-0.5">
                        {videoResult.limitations.map((lim, i) => (
                          <li key={i} className="text-[11px] text-slate-400 flex items-start gap-1.5">
                            <span className="text-amber-500 font-mono">•</span><span>{lim}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-[10px] text-slate-500 pt-1">{videoResult.disclaimer}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Prompt to scan */}
              {!videoResult && !videoAnalyzing && !videoError && (
                <div className="flex flex-col items-center justify-center gap-3 p-10 bg-slate-950/60 border border-dashed border-violet-800/30 rounded-xl text-center">
                  <Play className="w-10 h-10 text-violet-600" />
                  <p className="text-sm text-slate-400">Press <span className="text-violet-300 font-semibold">Run Video Scan</span> to extract keyframes and detect AI-generated or manipulated video content.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

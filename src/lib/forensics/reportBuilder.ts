import type {
  AnalysisFinding,
  EvidenceCertificate,
  EvidenceItem,
  ForensicReport,
  Investigation,
  ProvenanceEvent,
  UserProfile,
} from '@/types/forensics';
import type { ReportAuthenticationRecord } from './reportAuthentication';

export type ReportLanguage = 'en' | 'hi';
export type SimpleReportConclusion = 'likely_authentic' | 'likely_manipulated' | 'inconclusive' | 'unable_to_analyze';

/**
 * A single investigation question keeps its own conclusion so that a strong
 * result in one domain never silently promotes an unrelated conclusion.
 */
export type ReportDomain =
  | 'ai_content'
  | 'manipulation'
  | 'metadata'
  | 'cryptographic_integrity'
  | 'provenance'
  | 'signature';

export type DomainState = SimpleReportConclusion | 'checked';

export interface DomainConclusion {
  domain: ReportDomain;
  label: string;
  state: DomainState;
  note: string;
}

export interface GlossaryEntry {
  term: string;
  plain: string;
}

/** A durable visual record of a single uploaded evidence file. */
export interface EvidenceGalleryEntry {
  evidenceId: string;
  fileName: string;
  mediaType: string;
  mimeType: string;
  fileSizeBytes: number;
  imageUrl?: string;
  videoUrl?: string;
  sha256: string;
  caption: string;
}

export interface SimpleReportContent {
  reportId: string;
  caseNumber: string;
  title: string;
  caseSummary: string;
  conclusion: SimpleReportConclusion;
  conclusionLabel: string;
  checked: string[];
  findings: Array<{
    evidenceId: string;
    fileName: string;
    previewUrl: string;
    observation: string;
    explanation: string;
    text: string;
    altText: string;
  }>;
  findingDetails?: AnalysisFinding[];
  certificates?: EvidenceCertificate[];
  provenance?: ProvenanceEvent[];
  evidenceGallery: EvidenceGalleryEntry[];
  domainConclusions: DomainConclusion[];
  glossary: GlossaryEntry[];
  whatThisMeans: string;
  nextSteps: string[];
  limitations: string;
  evidenceIds: string[];
  analysisDate: string;
  timeline: {
    caseRegistered: string;
    evidenceReceived: string;
    reportGenerated: string;
  };
  confidenceLabel: string;
  detectorCount: number;
  examinerName?: string;
  examinerAgency?: string;
}

const COPY = {
  en: {
    noSummary: 'No case summary was recorded.',
    labels: {
      likely_authentic: 'No synthetic indicator in the recorded model result; authenticity not established',
      likely_manipulated: 'Model-indicated synthetic content (review required)',
      inconclusive: 'Suspicious / Inconclusive',
      unable_to_analyze: 'Unable to Analyze',
    },
    confidenceNotAssessed: 'Not assessed (no scored detector result recorded)',
    hashCheck: 'A cryptographic SHA-256 digital fingerprint was calculated from the uploaded file bytes.',
    metadataCheck: 'Available file metadata and EXIF headers were inspected.',
    findingCheck: 'Recorded forensic findings and anomaly observations were compiled.',
    noFindings: 'No suspicious anomalies or manipulation findings recorded for this evidence.',
    meaningAuthentic:
      'The recorded synthetic-content model reported no indicator, and the file hash matched a trusted reference. This does not prove that the media is authentic or that its depicted events occurred.',
    meaningManipulated:
      'A recorded model-scored finding indicated possible synthetic content. This is a model indication only, not proof that the media was generated or manipulated; independent expert review is required.',
    meaningInconclusive:
      'The available checks show suspicious patterns or insufficient baseline data, preventing a definitive conclusion. Independent expert examination is recommended.',
    meaningUnable:
      'No evidence files are attached or analytical checks could not be completed on the provided media.',
    nextOriginal: 'Secure and preserve the original camera source file and verify its hash against this record.',
    nextReview: 'Perform secondary multi-spectral and noise-residual analysis on an isolated workstation.',
    nextDetector: 'Cross-examine with secondary specialist AI-origin models and forensic video tools.',
    nextIndependent: 'Engage a certified forensic media expert to conduct peer review.',
    limitation:
      'This summary uses only the evidence records and findings currently saved in the local workspace. ELA is a JPEG recompression diagnostic, not proof of manipulation. Missing metadata is not proof of fraud. Puter visual review is experimental and is not a validated specialist AI-origin detector. Absence of a digital credential is not proof of forgery.',
    domains: {
      ai_content: 'AI-content visual assessment',
      manipulation: 'Image or video manipulation',
      metadata: 'Metadata consistency',
      cryptographic_integrity: 'Cryptographic integrity',
      provenance: 'Provenance verification',
      signature: 'Signature or stamp visual comparison',
    },
    domainNotes: {
      aiNotChecked: 'No validated specialist AI-origin detector is configured, so this question was not assessed.',
      aiVisualReviewRecorded: 'A general Puter vision model recorded a visual assessment. It is experimental, not a validated detector, and does not prove image origin.',
      aiIndicated: 'A detector-recorded finding indicated synthetic content; treat as a model indication, not proof.',
      aiNoIndicator: 'A recorded model result reported no synthetic-content indicator. This does not establish authenticity.',
      manipulationNotChecked: 'No validated manipulation detector was run. ELA is a recompression diagnostic and does not answer this question.',
      metadataChecked: 'Available metadata fields were read and any parser observations are listed above.',
      metadataAbsent: 'No supported metadata fields were present in the recorded file.',
      hashChecked: 'A SHA-256 fingerprint was recorded for the file bytes.',
      hashMissing: 'No SHA-256 fingerprint is recorded for the file.',
      hashVerified: 'The file digest matched a trusted reference digest supplied to the workspace.',
      provenanceChecked: 'Source and custody records exist for at least one file in this case.',
      provenanceAbsent: 'No source or custody record has been recorded. Missing provenance is not proof of forgery.',
      signatureChecked: 'A signature or stamp comparison was recorded; similarity is not proof of signer identity or authorization.',
      signatureAbsent: 'No signature or stamp comparison was recorded.',
    },
  },
  hi: {
    noSummary: 'मामले का कोई सारांश दर्ज नहीं किया गया है।',
    labels: {
      likely_authentic: 'दर्ज मॉडल परिणाम में कृत्रिम संकेत नहीं; प्रामाणिकता स्थापित नहीं',
      likely_manipulated: 'मॉडल ने कृत्रिम सामग्री का संकेत दिया (समीक्षा आवश्यक)',
      inconclusive: 'निष्कर्ष अस्पष्ट',
      unable_to_analyze: 'विश्लेषण संभव नहीं',
    },
    confidenceNotAssessed: 'आकलन नहीं हुआ (स्कोर वाला डिटेक्टर परिणाम दर्ज नहीं है)',
    hashCheck: 'अपलोड की गई फ़ाइल के वास्तविक डेटा से SHA-256 डिजिटल फ़िंगरप्रिंट निकाला गया।',
    metadataCheck: 'फ़ाइल में उपलब्ध मेटाडेटा फ़ील्ड देखे गए।',
    findingCheck: 'सूचीबद्ध साक्ष्य के लिए पहले से दर्ज निष्कर्ष शामिल किए गए।',
    noFindings: 'इस साक्ष्य के लिए कोई निष्कर्ष दर्ज नहीं है।',
    meaningAuthentic:
      'दर्ज कृत्रिम-सामग्री मॉडल में कोई संकेत नहीं मिला और फ़ाइल का हैश भरोसेमंद संदर्भ से मेल खाया। इससे मीडिया की प्रामाणिकता या उसमें दिखाई गई घटना साबित नहीं होती।',
    meaningManipulated:
      'दर्ज मॉडल-स्कोर वाले निष्कर्ष ने संभावित कृत्रिम सामग्री का संकेत दिया। यह केवल मॉडल का संकेत है, प्रमाण नहीं; स्वतंत्र विशेषज्ञ समीक्षा आवश्यक है।',
    meaningInconclusive:
      'दर्ज जाँचों से यह साबित नहीं होता कि दिखाई गई सामग्री असली है या बदली गई है। फ़ाइल का हैश उसके डेटा की पहचान करता है; इससे फ़ाइल बनाने वाले व्यक्ति या उसमें दिखाई गई घटना की पुष्टि नहीं होती।',
    meaningUnable:
      'इस मामले में कोई साक्ष्य संलग्न नहीं है, या पूरी हुई जाँचों का कोई रिकॉर्ड नहीं है, इसलिए फ़ाइल-स्तर का कोई निष्कर्ष नहीं दिया जा सकता।',
    nextOriginal: 'यदि उपलब्ध हो, तो मूल स्रोत फ़ाइल प्राप्त करके सुरक्षित रखें और उसका हैश इस प्रति से मिलाएँ।',
    nextReview: 'हर दर्ज अवलोकन को स्रोत मीडिया और उसकी बताई गई सीमाओं के साथ जाँचें।',
    nextDetector: 'मान्य विशेषज्ञ AI-मूल्यांकन मॉडल कॉन्फ़िगर नहीं है। ELA या गुम मेटाडेटा के आधार पर AI-मूल का निष्कर्ष न निकालें।',
    nextIndependent: 'किसी दूसरे योग्य परीक्षक से फ़ाइल की प्रति पर सबसे मजबूत दर्ज जाँच दोबारा कराएँ।',
    limitation:
      'यह सारांश केवल स्थानीय कार्यक्षेत्र में अभी सहेजे गए साक्ष्य और निष्कर्षों पर आधारित है। ELA JPEG को दोबारा संपीड़ित करने के अंतर दिखाता है; यह बदलाव का प्रमाण नहीं है। गुम मेटाडेटा धोखाधड़ी का प्रमाण नहीं है। Puter का दृश्य मूल्यांकन प्रयोगात्मक है और मान्य विशेषज्ञ AI डिटेक्टर नहीं है। डिजिटल प्रमाण-पत्र का न होना जालसाज़ी का प्रमाण नहीं है।',
    domains: {
      ai_content: 'AI सामग्री का दृश्य मूल्यांकन',
      manipulation: 'छवि या वीडियो में छेड़छाड़',
      metadata: 'मेटाडेटा की संगति',
      cryptographic_integrity: 'क्रिप्टोग्राफ़िक अखंडता',
      provenance: 'स्रोत की पुष्टि',
      signature: 'हस्ताक्षर या मोहर की दृश्य तुलना',
    },
    domainNotes: {
      aiNotChecked: 'मान्य विशेषज्ञ AI-मूल्यांकन मॉडल कॉन्फ़िगर नहीं है, इसलिए इस प्रश्न का मूल्यांकन नहीं किया गया।',
      aiVisualReviewRecorded: 'Puter के सामान्य vision model ने दृश्य मूल्यांकन दर्ज किया। यह प्रयोगात्मक है, मान्य डिटेक्टर नहीं है और छवि के स्रोत का प्रमाण नहीं है।',
      aiIndicated: 'मॉडल द्वारा दर्ज निष्कर्ष में कृत्रिम सामग्री का संकेत मिला; इसे मॉडल का संकेत मानें, प्रमाण नहीं।',
      aiNoIndicator: 'दर्ज मॉडल परिणाम में कृत्रिम सामग्री का संकेत नहीं मिला। इससे प्रामाणिकता साबित नहीं होती।',
      manipulationNotChecked: 'कोई मान्य छेड़छाड़ डिटेक्टर नहीं चलाया गया। ELA केवल पुनः-संपीड़न अंतर दिखाता है, इस प्रश्न का उत्तर नहीं देता।',
      metadataChecked: 'उपलब्ध मेटाडेटा फ़ील्ड पढ़े गए और पार्सर के अवलोकन ऊपर दर्ज हैं।',
      metadataAbsent: 'दर्ज फ़ाइल में कोई समर्थित मेटाडेटा फ़ील्ड मौजूद नहीं था।',
      hashChecked: 'फ़ाइल के डेटा के लिए SHA-256 फ़िंगरप्रिंट दर्ज किया गया।',
      hashMissing: 'फ़ाइल के लिए कोई SHA-256 फ़िंगरप्रिंट दर्ज नहीं है।',
      hashVerified: 'फ़ाइल का हैश कार्यक्षेत्र में दिए गए भरोसेमंद संदर्भ हैश से मेल खाया।',
      provenanceChecked: 'इस मामले में कम से कम एक फ़ाइल के लिए स्रोत और कस्टडी रिकॉर्ड मौजूद हैं।',
      provenanceAbsent: 'कोई स्रोत या कस्टडी रिकॉर्ड दर्ज नहीं है। स्रोत का अभाव जालसाज़ी का प्रमाण नहीं है।',
      signatureChecked: 'हस्ताक्षर या मोहर की तुलना दर्ज की गई; समानता हस्ताक्षरकर्ता की पहचान या अधिकार का प्रमाण नहीं है।',
      signatureAbsent: 'कोई हस्ताक्षर या मोहर तुलना दर्ज नहीं की गई।',
    },
  },
} satisfies Record<ReportLanguage, any>;

const GLOSSARY: Record<ReportLanguage, GlossaryEntry[]> = {
  en: [
    { term: 'SHA-256', plain: 'A digital fingerprint calculated from a file. The same bytes always give the same fingerprint. It can show two copies are identical, but it cannot tell you who made a file or whether its content is truthful.' },
    { term: 'ELA (Error Level Analysis)', plain: 'A picture that highlights areas of an image that were re-saved at a different JPEG quality. Bright edges can appear after normal editing, sharing, or resizing, so ELA alone cannot prove manipulation.' },
    { term: 'EXIF metadata', plain: 'Hidden information a camera or app may store inside a photo, such as camera model, date, and settings. It can be missing or edited, so its absence is not proof of fraud.' },
    { term: 'Perceptual hash', plain: 'A compact summary of how an image looks. Two images that look similar have close perceptual hashes, which helps spot near-duplicates that are not byte-identical.' },
    { term: 'Provenance', plain: 'The recorded history of where a file came from and who handled it. A gap in provenance is simply a gap in records, not proof that a file is fake.' },
  ],
  hi: [
    { term: 'SHA-256', plain: 'फ़ाइल से निकाला गया डिजिटल फ़िंगरप्रिंट। एक जैसे डेटा का फ़िंगरप्रिंट हमेशा एक जैसा होता है। यह बता सकता है कि दो प्रतियाँ एक जैसी हैं, पर यह नहीं बता सकता कि फ़ाइल किसने बनाई या उसकी सामग्री सच है या नहीं।' },
    { term: 'ELA (एरर लेवल एनालिसिस)', plain: 'एक चित्र जो दिखाता है कि छवि के कौन-से हिस्से अलग JPEG गुणवत्ता पर दोबारा सहेजे गए। सामान्य संपादन, साझा करने या आकार बदलने के बाद भी चमकीले किनारे दिख सकते हैं, इसलिए अकेला ELA छेड़छाड़ साबित नहीं करता।' },
    { term: 'EXIF मेटाडेटा', plain: 'कैमरा या ऐप फ़ोटो के अंदर छिपी जानकारी रख सकते हैं, जैसे कैमरा मॉडल, तारीख़ और सेटिंग। यह गुम या बदला जा सकता है, इसलिए इसका न होना धोखाधड़ी का प्रमाण नहीं है।' },
    { term: 'परसेप्चुअल हैश', plain: 'छवि दिखने में कैसी है, इसका छोटा सारांश। दिखने में मिलती-जुलती दो छवियों के हैश पास होते हैं, जिससे लगभग-समान (पर बाइट-समान नहीं) फ़ाइलें पहचानी जा सकती हैं।' },
    { term: 'स्रोत (प्रोवेनेंस)', plain: 'किसी फ़ाइल का दर्ज इतिहास कि वह कहाँ से आई और किसने संभाली। स्रोत में कमी केवल रिकॉर्ड की कमी है, फ़ाइल के नकली होने का प्रमाण नहीं।' },
  ],
};

function isCalculatedHash(value: string): boolean {
  return /^[a-f\d]{64}$/i.test(value || '');
}

/**
 * A recorded, model-produced synthetic-content indicator is the ONLY signal
 * that can support a "likely manipulated" conclusion. ELA, metadata, and
 * missing credentials are explicitly excluded because they cannot support it.
 */
function hasModelSyntheticIndicator(findings: AnalysisFinding[]): boolean {
  return findings.some((finding) => {
    const isSyntheticCategory = finding.category === 'synthetic_deepfake';
    const producedByModel = typeof finding.rawDetectorScore === 'number' || typeof finding.confidenceScore === 'number';
    return isSyntheticCategory && producedByModel && (finding.severity === 'critical' || finding.severity === 'high');
  });
}

function hasModelCleanResult(findings: AnalysisFinding[]): boolean {
  return findings.some(
    (finding) =>
      finding.category === 'synthetic_deepfake' &&
      (typeof finding.rawDetectorScore === 'number' || typeof finding.confidenceScore === 'number') &&
      finding.severity === 'nominal'
  );
}

function buildDomainConclusions({
  evidence,
  findings,
  provenance,
  copy,
}: {
  evidence: EvidenceItem[];
  findings: AnalysisFinding[];
  provenance: ProvenanceEvent[];
  copy: (typeof COPY)['en'];
}): DomainConclusion[] {
  const notes = copy.domainNotes;
  const domains = copy.domains;
  const results: DomainConclusion[] = [];

  // 1. AI-generated content
  if (hasModelSyntheticIndicator(findings)) {
    results.push({ domain: 'ai_content', label: domains.ai_content, state: 'likely_manipulated', note: notes.aiIndicated });
  } else if (hasModelCleanResult(findings)) {
    results.push({ domain: 'ai_content', label: domains.ai_content, state: 'checked', note: notes.aiNoIndicator });
  } else if (findings.some((finding) => finding.detectionMethod === 'AI Image Detection (Puter.js visual model)')) {
    results.push({ domain: 'ai_content', label: domains.ai_content, state: 'checked', note: notes.aiVisualReviewRecorded });
  } else {
    results.push({ domain: 'ai_content', label: domains.ai_content, state: 'unable_to_analyze', note: notes.aiNotChecked });
  }

  // 2. Manipulation (kept separate from AI content)
  results.push({ domain: 'manipulation', label: domains.manipulation, state: 'unable_to_analyze', note: notes.manipulationNotChecked });

  // 3. Metadata consistency
  const withMetadata = evidence.filter((item) => Object.keys(item.metadata || {}).length > 0);
  if (evidence.length === 0) {
    results.push({ domain: 'metadata', label: domains.metadata, state: 'unable_to_analyze', note: notes.metadataAbsent });
  } else if (withMetadata.length > 0) {
    const observationCount = withMetadata.reduce((total, item) => total + (item.metadata.inconsistenciesDetected?.length || 0), 0);
    results.push({
      domain: 'metadata',
      label: domains.metadata,
      state: 'checked',
      note: observationCount > 0 ? `${notes.metadataChecked} Parser observations: ${observationCount}.` : notes.metadataChecked,
    });
  } else {
    results.push({ domain: 'metadata', label: domains.metadata, state: 'unable_to_analyze', note: notes.metadataAbsent });
  }

  // 4. Cryptographic integrity
  const hashed = evidence.filter((item) => isCalculatedHash(item.sha256Hash));
  const verified = evidence.filter((item) => item.verified === true);
  if (evidence.length === 0) {
    results.push({ domain: 'cryptographic_integrity', label: domains.cryptographic_integrity, state: 'unable_to_analyze', note: notes.hashMissing });
  } else if (hashed.length > 0) {
    results.push({
      domain: 'cryptographic_integrity',
      label: domains.cryptographic_integrity,
      state: 'checked',
      note: verified.length > 0 ? notes.hashVerified : notes.hashChecked,
    });
  } else {
    results.push({ domain: 'cryptographic_integrity', label: domains.cryptographic_integrity, state: 'unable_to_analyze', note: notes.hashMissing });
  }

  // 5. Provenance
  const caseEvidenceIds = new Set(evidence.map((item) => item.id));
  const caseProvenance = provenance.filter((event) => caseEvidenceIds.has(event.evidenceId));
  results.push({
    domain: 'provenance',
    label: domains.provenance,
    state: caseProvenance.length > 0 ? 'checked' : 'unable_to_analyze',
    note: caseProvenance.length > 0 ? notes.provenanceChecked : notes.provenanceAbsent,
  });

  // 6. Signature or stamp comparison
  const signatureFindings = findings.filter((finding) => /signature|stamp|handwriting/i.test(finding.detectionMethod || '') || /signature|stamp|handwriting/i.test(finding.title || ''));
  results.push({
    domain: 'signature',
    label: domains.signature,
    state: signatureFindings.length > 0 ? 'checked' : 'unable_to_analyze',
    note: signatureFindings.length > 0 ? notes.signatureChecked : notes.signatureAbsent,
  });

  return results;
}

export function buildSimpleReportContent({
  investigation,
  evidence,
  findings,
  provenance = [],
  reportId,
  analysisDate,
  reportGeneratedAt = analysisDate,
  language = 'en',
  examinerName,
  examinerAgency,
  certificates = [],
}: {
  investigation: Investigation;
  evidence: EvidenceItem[];
  findings: AnalysisFinding[];
  provenance?: ProvenanceEvent[];
  reportId: string;
  analysisDate: string;
  reportGeneratedAt?: string;
  language?: ReportLanguage;
  examinerName?: string;
  examinerAgency?: string;
  certificates?: EvidenceCertificate[];
}): SimpleReportContent {
  const copy = COPY[language];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const evidenceFindings = findings.filter((finding) => evidenceIds.has(finding.evidenceId));
  const detectorCount = new Set(evidenceFindings
    .filter((finding) => finding.category === 'synthetic_deepfake' &&
      (typeof finding.rawDetectorScore === 'number' || typeof finding.confidenceScore === 'number'))
    .map((finding) => `${finding.detectionMethod}:${finding.detectorVersion}`)
  ).size;
  const checks: string[] = [];

  if (evidence.some((item) => isCalculatedHash(item.sha256Hash))) {
    checks.push(copy.hashCheck);
  }
  if (evidence.some((item) => Object.keys(item.metadata || {}).length > 0)) {
    checks.push(copy.metadataCheck);
  }
  if (evidenceFindings.length > 0) {
    checks.push(copy.findingCheck);
  }

  // Conservative, explainable conclusion derivation.
  let conclusion: SimpleReportConclusion;
  if (evidence.length === 0 || checks.length === 0) {
    conclusion = 'unable_to_analyze';
  } else if (hasModelSyntheticIndicator(evidenceFindings)) {
    conclusion = 'likely_manipulated';
  } else if (hasModelCleanResult(evidenceFindings) && evidence.every((item) => item.verified === true)) {
    conclusion = 'likely_authentic';
  } else {
    conclusion = 'inconclusive';
  }

  const meaningByConclusion: Record<SimpleReportConclusion, string> = {
    likely_authentic: copy.meaningAuthentic,
    likely_manipulated: copy.meaningManipulated,
    inconclusive: copy.meaningInconclusive,
    unable_to_analyze: copy.meaningUnable,
  };

  const nextStepsByConclusion: Record<SimpleReportConclusion, string[]> = {
    likely_authentic: [copy.nextOriginal, copy.nextReview],
    likely_manipulated: [copy.nextIndependent, copy.nextReview, copy.nextDetector],
    inconclusive: [copy.nextOriginal, copy.nextReview, copy.nextDetector],
    unable_to_analyze: evidence.length === 0 ? [copy.nextOriginal] : [copy.nextOriginal, copy.nextReview],
  };

  return {
    reportId,
    caseNumber: investigation.caseNumber,
    title: investigation.title,
    caseSummary: investigation.description || copy.noSummary,
    conclusion,
    conclusionLabel: copy.labels[conclusion],
    checked: checks,
    findings: evidence.length === 0
      ? []
      : evidence.map((item) => {
          const itemFindings = evidenceFindings.filter((finding) => finding.evidenceId === item.id);
          return {
            evidenceId: item.id,
            fileName: item.fileName,
            previewUrl: item.thumbnailUrl || item.previewUrl,
            observation: itemFindings.length > 0
              ? itemFindings.map((finding) => finding.observedEvidence).filter(Boolean).join(' ')
              : copy.noFindings,
            explanation: itemFindings
              .map((finding) => finding.simpleExplanation || finding.plainEnglishSummary)
              .filter((value): value is string => Boolean(value))
              .join(' '),
            text: itemFindings.length > 0
              ? itemFindings.map((finding) => finding.observedEvidence).filter(Boolean).join(' ')
              : copy.noFindings,
            altText: `${item.mediaType === 'image' ? 'Image' : item.mediaType} evidence file ${item.fileName} submitted for examination.`,
          };
        }),
    findingDetails: evidenceFindings,
    certificates,
    provenance,
    domainConclusions: buildDomainConclusions({ evidence, findings: evidenceFindings, provenance, copy }),
    evidenceGallery: evidence.map((item) => ({
      evidenceId: item.id,
      fileName: item.fileName,
      mediaType: item.mediaType,
      mimeType: item.mimeType,
      fileSizeBytes: item.fileSize,
      imageUrl: item.mediaType === 'image'
        ? item.thumbnailUrl || item.previewUrl
        : item.mediaType === 'video'
        ? item.thumbnailUrl
        : undefined,
      videoUrl: item.mediaType === 'video' ? item.previewUrl || item.storageUrl : undefined,
      sha256: isCalculatedHash(item.sha256Hash) ? item.sha256Hash : '',
      caption: `${item.fileName} — uploaded evidence (visual record only; not proof of authenticity).`,
    })),
    glossary: GLOSSARY[language],
    whatThisMeans: meaningByConclusion[conclusion],
    nextSteps: nextStepsByConclusion[conclusion],
    limitations: copy.limitation,
    evidenceIds: evidence.map((item) => item.id),
    analysisDate,
    timeline: {
      caseRegistered: investigation.createdAt,
      evidenceReceived: evidence.length
        ? evidence.reduce((earliest, item) => item.createdAt < earliest ? item.createdAt : earliest, evidence[0].createdAt)
        : '',
      reportGenerated: reportGeneratedAt,
    },
    confidenceLabel: detectorCount > 0
      ? `Recorded score from ${detectorCount} detector result(s); not a calibrated probability`
      : copy.confidenceNotAssessed,
    detectorCount,
    examinerName,
    examinerAgency,
  };
}

export function formatTimelineDate(dateValue?: string): string {
  if (!dateValue) return 'Not available';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return dateValue;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function getReportTimelineSummary(timeline: { caseRegistered: string; evidenceReceived: string; reportGenerated: string }): string {
  return `Case Registered: ${formatTimelineDate(timeline.caseRegistered)} | Evidence Received: ${formatTimelineDate(timeline.evidenceReceived)} | Report: ${formatTimelineDate(timeline.reportGenerated)}`;
}

export function buildForensicReport({
  investigation,
  evidence,
  findings,
  user,
  reportId,
  createdAt,
  certificates = [],
  provenance = [],
}: {
  investigation: Investigation;
  evidence: EvidenceItem[];
  findings: AnalysisFinding[];
  user: UserProfile;
  reportId: string;
  createdAt: string;
  certificates?: EvidenceCertificate[];
  provenance?: ProvenanceEvent[];
}): ForensicReport {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const caseFindings = findings.filter((finding) => evidenceIds.has(finding.evidenceId));
  const methods = new Set<string>();

  if (evidence.some((item) => isCalculatedHash(item.sha256Hash))) methods.add('SHA-256 file digest');
  if (evidence.some((item) => Object.keys(item.metadata || {}).length > 0)) methods.add('Available metadata inspection');
  for (const finding of caseFindings) {
    if (finding.detectionMethod) methods.add(finding.detectionMethod);
  }

  return {
    id: reportId,
    investigationId: investigation.id,
    caseNumber: investigation.caseNumber,
    reportNumber: reportId,
    title: investigation.title,
    summary: investigation.description || 'No case summary was recorded.',
    leadInvestigator: user.fullName,
    badgeNumber: user.badgeNumber,
    agency: user.agency,
    createdAt,
    caseRegisteredAt: investigation.createdAt,
    evidenceList: evidence.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      mediaType: item.mediaType,
      sha256: item.sha256Hash,
      fileSizeBytes: item.fileSize,
      mimeType: item.mimeType,
      hashStatus: isCalculatedHash(item.sha256Hash) ? 'calculated' : 'not_available',
      previewUrl: item.previewUrl,
      thumbnailUrl: item.thumbnailUrl,
      metadata: item.metadata,
      isOriginal: item.isOriginal,
      verified: item.verified,
      createdAt: item.createdAt,
      findingsCount: caseFindings.filter((finding) => finding.evidenceId === item.id).length,
    })),
    findings: caseFindings,
    certificates,
    provenance,
    methodologiesUsed: [...methods],
    disclaimers: [
      'This report reflects only evidence and findings recorded in the local workspace at generation time.',
      'ELA is a JPEG recompression diagnostic; it does not independently establish manipulation or AI origin.',
      'A calculated SHA-256 digest identifies file bytes and does not establish authenticity or authorship.',
      'Puter AI Image Detection is an experimental visual-language-model opinion, not a validated specialist detector or proof of image origin.',
    ],
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}

function isLocalImageUrl(value: string | undefined): value is string {
  return Boolean(value && (
    (value.startsWith('/') && !value.startsWith('//')) ||
    value.startsWith('blob:') ||
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(value)
  ));
}

function isSafeVideoUrl(value: string | undefined): value is string {
  if (!value) return false;
  if ((value.startsWith('/') && !value.startsWith('//')) || value.startsWith('blob:')) return true;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function buildPrintableReportHtml({
  mode,
  language,
  simpleReport,
  report,
  authentication,
  provenance,
}: {
  mode: 'simple' | 'detailed';
  language: ReportLanguage;
  simpleReport: SimpleReportContent;
  report: ForensicReport;
  provenance?: ProvenanceEvent[];
  authentication?: {
    record: ReportAuthenticationRecord;
    verificationUrl: string;
    qrDataUrl: string;
    signatureImageUrl?: string;
  };
}): string {
  const reportProvenance = provenance ?? report.provenance ?? [];
  const labels = language === 'hi'
    ? { checked: 'क्या जाँचा गया', findings: 'मुख्य निष्कर्ष', observation: 'दर्ज अवलोकन', explanation: 'व्याख्या', meaning: 'इसका क्या अर्थ है?', next: 'अब क्या करें?', limits: 'सीमाएँ और अनिश्चितता', evidence: 'साक्ष्य', method: 'विधि', metadata: 'उपलब्ध मेटाडेटा', summary: 'मामले का सारांश', report: 'रिपोर्ट', analysisDate: 'विश्लेषण तिथि', hash: 'SHA-256 डिजिटल फ़िंगरप्रिंट', domains: 'क्षेत्र-वार निष्कर्ष', glossary: 'तकनीकी शब्दों के अर्थ', custody: 'दर्ज चेन-ऑफ़-कस्टडी', confidential: 'गोपनीय — डिजिटल फॉरेंसिक जाँच', examiner: 'परीक्षक' }
    : { checked: 'What was checked', findings: 'Key findings', observation: 'Recorded observation', explanation: 'Explanation', meaning: 'What does this mean?', next: 'What should I do next?', limits: 'Limitations and uncertainty', evidence: 'Evidence', method: 'Method', metadata: 'Available metadata', summary: 'Case summary', report: 'Report', analysisDate: 'Analysis date', hash: 'SHA-256 digital fingerprint', domains: 'Findings by question', glossary: 'Technical terms explained', custody: 'Recorded chain of custody', confidential: 'CONFIDENTIAL — DIGITAL FORENSIC EXAMINATION', examiner: 'Examiner' };
  const heading = language === 'hi' ? 'VexaLens सरल रिपोर्ट' : 'VexaLens Report';
  const evidenceRows = report.evidenceList.map((item) => {
    const metadata = [
      item.metadata.fileFormat && `Format: ${item.metadata.fileFormat}`,
      item.metadata.dimensions && `Dimensions: ${item.metadata.dimensions.width} × ${item.metadata.dimensions.height}`,
      item.metadata.colorSpace && `Color: ${item.metadata.colorSpace}`,
      item.metadata.cameraMake && `Camera make: ${item.metadata.cameraMake}`,
      item.metadata.cameraModel && `Camera model: ${item.metadata.cameraModel}`,
      item.metadata.software && `Software tag: ${item.metadata.software}`,
      item.metadata.videoSpecs?.videoCodec && `Video codec: ${item.metadata.videoSpecs.videoCodec}`,
      item.metadata.videoSpecs?.durationSec && `Duration: ${item.metadata.videoSpecs.durationSec} s`,
      item.metadata.audioSpecs?.sampleRateHz && `Sample rate: ${item.metadata.audioSpecs.sampleRateHz} Hz`,
      item.metadata.audioSpecs?.channels && `Channels: ${item.metadata.audioSpecs.channels}`,
    ].filter(Boolean).join(' · ');
    const displayUrl = item.thumbnailUrl || item.previewUrl;
    const imagePreview = item.mediaType === 'image' && isLocalImageUrl(displayUrl)
      ? `<img src="${escapeHtml(displayUrl)}" alt="${escapeHtml(item.fileName)} visual evidence" style="max-width:100%;max-height:360px;object-fit:contain">`
      : '';
    const videoPreview = item.mediaType === 'video' && isSafeVideoUrl(item.previewUrl)
      ? `<video src="${escapeHtml(item.previewUrl)}" ${isLocalImageUrl(item.thumbnailUrl) ? `poster="${escapeHtml(item.thumbnailUrl)}"` : ''} controls playsinline preload="metadata" style="max-width:100%;max-height:360px"></video>`
      : '';
    const preview = imagePreview || videoPreview
      ? `<figure>${imagePreview || videoPreview}<figcaption>${escapeHtml(item.fileName)} — ${item.mediaType === 'video' ? 'video playback available in the interactive report; static PDF contains only a representative frame when available.' : 'visual evidence (not proof of authenticity).'}</figcaption></figure>`
      : '';
    return `<section><h3>${escapeHtml(item.fileName)}</h3><p>${labels.evidence} ID: ${escapeHtml(item.id)} · ${escapeHtml(item.mediaType)} · ${item.fileSizeBytes} bytes</p><p>${labels.hash}: ${item.hashStatus === 'calculated' ? escapeHtml(item.sha256) : 'Not available'}</p>${mode === 'detailed' ? `<p>${labels.metadata}: ${escapeHtml(metadata || 'No supported metadata recorded.')}</p>` : ''}${preview}</section>`;
  }).join('');
  const findings = report.findings.map((finding) => `<section><h3>${escapeHtml(finding.title)}</h3><p><b>${labels.evidence} ID:</b> ${escapeHtml(finding.evidenceId)}</p><p class="observation"><b>${labels.observation}:</b> ${escapeHtml(finding.observedEvidence)}</p><p class="explanation"><b>${labels.explanation}:</b> ${escapeHtml(finding.simpleExplanation || finding.plainEnglishSummary || 'No explanation recorded.')}</p>${mode === 'detailed' ? `<p><b>Technical observation:</b> ${escapeHtml(finding.technicalExplanation || finding.observedEvidence)}</p><p><b>${labels.method}:</b> ${escapeHtml(finding.detectionMethod || 'Not supplied')}${finding.detectorVersion ? ` · ${escapeHtml(finding.detectorVersion)}` : ''}</p>${typeof finding.rawDetectorScore === 'number' ? `<p>Raw detector score: ${finding.rawDetectorScore}${finding.scoreInterpretation ? ` · ${escapeHtml(finding.scoreInterpretation)}` : ''}</p>` : ''}<p><b>Limitations:</b> ${escapeHtml(finding.limitations || finding.potentialFalsePositives || 'Not supplied')}</p>` : ''}</section>`).join('');
  const domainRows = simpleReport.domainConclusions.map((domain) => `<tr><th scope="row">${escapeHtml(domain.label)}</th><td>${escapeHtml(domain.state.replace(/_/g, ' '))}</td><td>${escapeHtml(domain.note)}</td></tr>`).join('');
  const glossaryRows = simpleReport.glossary.map((entry) => `<p><b>${escapeHtml(entry.term)}:</b> ${escapeHtml(entry.plain)}</p>`).join('');
  const galleryHtml = simpleReport.evidenceGallery.map((entry) => {
    const image = entry.imageUrl && isLocalImageUrl(entry.imageUrl)
      ? `<img src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.fileName)} uploaded evidence" style="max-width:100%;max-height:280px;object-fit:contain">`
      : '';
    const video = entry.videoUrl && isSafeVideoUrl(entry.videoUrl)
      ? `<video src="${escapeHtml(entry.videoUrl)}" ${entry.imageUrl && isLocalImageUrl(entry.imageUrl) ? `poster="${escapeHtml(entry.imageUrl)}"` : ''} controls playsinline preload="metadata" style="max-width:100%;max-height:280px"></video>`
      : '';
    return `<section><h3>${escapeHtml(entry.fileName)}</h3><p class="meta">${labels.evidence} ID: ${escapeHtml(entry.evidenceId)} · ${escapeHtml(entry.mediaType)}</p><p class="meta">${labels.hash}: ${entry.sha256 ? escapeHtml(entry.sha256) : 'Not available'}</p>${video || image}<figcaption>${escapeHtml(entry.caption)}${video ? ' Video playback is available in the interactive report; static PDF shows a representative frame only.' : ''}</figcaption></section>`;
  }).join('');
  const simpleFindings = simpleReport.findings.map((finding) =>
    `<section><h3>${escapeHtml(finding.fileName)}</h3><p><b>${labels.evidence} ID:</b> ${escapeHtml(finding.evidenceId)}</p><p class="observation"><b>${labels.observation}:</b> ${escapeHtml(finding.observation)}</p>${finding.explanation ? `<p class="explanation"><b>${labels.explanation}:</b> ${escapeHtml(finding.explanation)}</p>` : ''}</section>`
  ).join('');
  const mediaSections = [
    { mediaType: 'image', title: language === 'hi' ? 'फ़ोटो अवलोकन' : 'Photo observations' },
    { mediaType: 'video', title: language === 'hi' ? 'वीडियो अवलोकन' : 'Video observations' },
    { mediaType: 'audio', title: language === 'hi' ? 'ऑडियो अवलोकन' : 'Audio observations' },
    { mediaType: 'document', title: language === 'hi' ? 'दस्तावेज़ और स्क्रीनशॉट अवलोकन' : 'Document and screenshot observations' },
    { mediaType: 'other', title: language === 'hi' ? 'अन्य साक्ष्य अवलोकन' : 'Other evidence observations' },
  ];
  const findingsByMedia = (mediaType: string) => {
    const mediaIds = new Set(report.evidenceList.filter((item) => mediaType === 'other'
      ? !['image', 'video', 'audio', 'document'].includes(item.mediaType)
      : item.mediaType === mediaType).map((item) => item.id));
    return report.findings.filter((finding) => mediaIds.has(finding.evidenceId));
  };
  const renderFindingSections = (mediaType: string, title: string, deepfakeOnly = false) => {
    const scopedFindings = (deepfakeOnly
      ? report.findings.filter((finding) => finding.category === 'synthetic_deepfake')
      : findingsByMedia(mediaType));
    const content = scopedFindings.map((finding) =>
      `<section><h3>${escapeHtml(finding.title)}</h3><p><b>${labels.evidence} ID:</b> ${escapeHtml(finding.evidenceId)}</p><p class="observation"><b>${labels.observation}:</b> ${escapeHtml(finding.observedEvidence)}</p><p class="explanation"><b>${labels.explanation}:</b> ${escapeHtml(finding.simpleExplanation || finding.plainEnglishSummary || 'No explanation recorded.')}</p></section>`
    ).join('') || `<p>No ${escapeHtml(title.toLowerCase())} have been recorded.</p>`;
    return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
  };
  const categorizedFindingsHtml = mediaSections
    .map((section) => renderFindingSections(section.mediaType, section.title))
    .join('') + renderFindingSections('', language === 'hi' ? 'डीपफेक निष्कर्ष' : 'Deepfake findings', true);
  const certificatesHtml = report.certificates?.length
    ? `<section><h2>Certificates</h2>${report.certificates.map((certificate) => `<article><h3>${escapeHtml(certificate.certificateId)}</h3><p><b>File:</b> ${escapeHtml(certificate.fileName)} · <b>Status:</b> ${escapeHtml(certificate.status)}</p><p><b>SHA-256:</b> ${escapeHtml(certificate.sha256Hash || 'Not available')}</p><p><b>Issued:</b> ${escapeHtml(formatTimelineDate(certificate.analysisTimestamp))} · <b>Examiner:</b> ${escapeHtml(certificate.examinerName || 'Not available')}</p><p>This certificate records information about the file; it does not prove who created it or that its contents are true.</p></article>`).join('')}</section>`
    : '<section><h2>Certificates</h2><p>No certificates have been recorded for this case.</p></section>';
  const custodyHtml = reportProvenance.length
    ? `<section><h2>${labels.custody}</h2><table><thead><tr><th>Action</th><th>Actor</th><th>Timestamp</th><th>Recorded SHA-256</th><th>Notes</th></tr></thead><tbody>${reportProvenance.map((event) => `<tr><td>${escapeHtml(event.actionType.replace(/_/g, ' '))}</td><td>${escapeHtml(event.actor || 'Not available')}</td><td>${escapeHtml(formatTimelineDate(event.timestamp))}</td><td class="hash">${escapeHtml(event.recordedSha256 || 'Not available')}</td><td>${escapeHtml(event.notes || 'No notes recorded.')}</td></tr>`).join('')}</tbody></table></section>`
    : `<section><h2>${labels.custody}</h2><p>No chain-of-custody events have been recorded.</p></section>`;
  const body = mode === 'simple'
    ? `<p><b>${escapeHtml(simpleReport.conclusionLabel)}</b></p><section><h2>${labels.summary}</h2><p>${escapeHtml(simpleReport.caseSummary)}</p></section><section><h2>${labels.checked}</h2><ul>${simpleReport.checked.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No file-level checks are recorded.</li>'}</ul></section>${simpleReport.evidenceGallery.length ? `<section><h2>${labels.evidence}</h2>${galleryHtml}</section>` : ''}<section><h2>${labels.domains}</h2><table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:10pt"><tbody>${domainRows}</tbody></table></section>${categorizedFindingsHtml || `<section><h2>${labels.findings}</h2>${simpleFindings || '<p>No findings have been recorded.</p>'}</section>`}<section><h2>${labels.meaning}</h2><p>${escapeHtml(simpleReport.whatThisMeans)}</p></section><section><h2>${labels.next}</h2><ol>${simpleReport.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section><section><h2>${labels.glossary}</h2>${glossaryRows}</section><section><h2>${labels.limits}</h2><p>${escapeHtml(simpleReport.limitations)}</p></section>${certificatesHtml}${custodyHtml}`
    : `<section><h2>${labels.summary}</h2><p>${escapeHtml(report.summary)}</p></section><section><h2>${labels.evidence}</h2>${evidenceRows || '<p>No evidence is attached.</p>'}</section>${categorizedFindingsHtml || `<section><h2>${labels.findings}</h2>${findings || '<p>No findings have been recorded.</p>'}</section>`}<section><h2>${labels.domains}</h2><table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:10pt"><tbody>${domainRows}</tbody></table></section><section><h2>Methods recorded</h2><ul>${(report.methodologiesUsed || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No analysis methods are recorded.</li>'}</ul></section><section><h2>${labels.limits}</h2><ul>${(report.disclaimers || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>${certificatesHtml}${custodyHtml}`;
  const signatureSection = authentication
    ? `<section class="signature"><div><h2>${language === 'hi' ? 'परीक्षक के हस्ताक्षर और QR सत्यापन' : 'Examiner signature & QR verification'}</h2><p class="electronic-signature">Electronically signed</p><p><b>${language === 'hi' ? 'हस्ताक्षरकर्ता' : 'Signed by'}:</b> ${escapeHtml(authentication.record.examinerName || 'Not available')}${authentication.record.agency ? ` · ${escapeHtml(authentication.record.agency)}` : ''}</p><p><b>${language === 'hi' ? 'परीक्षक बैज' : 'Examiner badge'}:</b> ${escapeHtml(authentication.record.examinerBadge || 'Not available')}</p><p><b>${language === 'hi' ? 'हस्ताक्षरित' : 'Signed'}:</b> ${escapeHtml(formatTimelineDate(authentication.record.issuedAt))} · ${escapeHtml(authentication.record.keyId)}</p><p class="hash"><b>Report SHA-256:</b> ${escapeHtml(authentication.record.reportHash)}</p><p class="hash"><b>Digital signature:</b> ${escapeHtml(authentication.record.signature)}</p><p><a href="${escapeHtml(authentication.verificationUrl)}">${language === 'hi' ? 'ऑनलाइन सत्यापन खोलें' : 'Open online verification'}</a></p><p class="meta">${language === 'hi' ? 'QR हस्ताक्षरित रिपोर्ट फ़िंगरप्रिंट की जाँच करता है, PDF फ़ाइल बाइट्स की नहीं।' : 'The QR checks the signed report fingerprint, not the PDF file bytes.'}</p></div><div class="seal"><b>VEXALENS FORENSICS</b><br><strong>REPORT SIGNED</strong><br>NOT AUTHENTICITY PROOF</div><img class="qr" src="${escapeHtml(authentication.qrDataUrl)}" alt="QR code to verify the signed report fingerprint"></section>`
    : '';

  const coverEvidence = report.evidenceList.map((item) =>
    `<li>${escapeHtml(item.fileName)} · ${escapeHtml(item.mimeType || item.mediaType)}</li>`
  ).join('');
  const cover = `<section class="cover"><div class="brand">VEXALENS <span> DIGITAL MEDIA FORENSICS LABORATORY</span></div><h1>DIGITAL MEDIA FORENSIC ANALYSIS REPORT</h1><p class="subtitle">Evidence Examination, Authenticity Assessment & Integrity Verification</p><p class="confidential">${labels.confidential}</p><dl><dt>Case ID</dt><dd>${escapeHtml(report.caseNumber)}</dd><dt>Report ID</dt><dd>${escapeHtml(report.reportNumber)}</dd><dt>${labels.analysisDate}</dt><dd>${escapeHtml(formatTimelineDate(simpleReport.analysisDate))}</dd><dt>Report generated</dt><dd>${escapeHtml(formatTimelineDate(report.createdAt))}</dd><dt>${labels.examiner}</dt><dd>${escapeHtml(report.leadInvestigator || 'Not available')}</dd></dl><h2>${labels.evidence}</h2><ul>${coverEvidence || '<li>Not available</li>'}</ul></section>`;

  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)} · ${escapeHtml(report.reportNumber)}</title><style>@page{size:A4;margin:18mm;@bottom-right{content:"Page " counter(page);font:8pt Arial,sans-serif;color:#64748b}}*{box-sizing:border-box}body{font-family:"Nirmala UI",Mangal,"Noto Sans Devanagari",Arial,sans-serif;color:#17212b;font-size:11pt;line-height:1.55}.cover{min-height:250mm;margin:-18mm;padding:28mm 22mm;background:#0a1424;color:#f8fafc;break-after:page;position:relative;overflow:hidden}.cover:after{content:"";position:absolute;right:-35mm;top:28mm;width:100mm;height:100mm;border:1px solid #1b3146;border-radius:50%;box-shadow:0 0 0 15mm #0a1424,0 0 0 15.2mm #1b3146,0 0 0 30mm #0a1424,0 0 0 30.2mm #1b3146;opacity:.7}.brand{font-size:12pt;font-weight:800;color:#58d2d8;letter-spacing:.12em}.brand span{font-size:8pt;color:#becddc;font-weight:400}.cover h1{max-width:150mm;margin-top:24mm;font-size:27pt;line-height:1.15;border-bottom:1px solid #2d455b;padding-bottom:8mm}.subtitle{font-size:12pt;color:#a1b7ca}.confidential{margin:14mm 0 8mm;color:#5dd4d8;font-size:9pt;font-weight:700;letter-spacing:.08em}.cover dl{display:grid;grid-template-columns:42mm 1fr;gap:4mm 5mm;color:#dce6ef;font-size:9pt}.cover dt{color:#90a4b8}.cover h2{margin-top:14mm;color:#5dd4d8}.cover ul{padding-left:5mm;max-width:160mm}.cover li{overflow-wrap:anywhere}h1{font-size:22pt;border-bottom:2px solid #158b9d;padding-bottom:8px}h2{font-size:14pt;margin-top:20px;border-bottom:1px solid #c8d1d8;padding-bottom:4px;break-after:avoid}h3{font-size:11pt;margin:8px 0 2px}section,figure,tr{break-inside:avoid;margin:10px 0}p{margin:4px 0}figcaption{color:#52616c;font-size:9pt}.meta{color:#52616c;font-size:9pt}.signature{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:28px;padding:16px;border:1px solid #d5e0e8;border-radius:10px;background:#f8fafc}.signature .qr{width:110px;height:110px}.electronic-signature{font:italic 16pt Georgia,serif;color:#0f766e}.seal{border:3px double #047857;border-radius:50%;padding:25px 12px;text-align:center;color:#047857;font-size:8pt}.hash{font:8pt ui-monospace,monospace;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{border:1px solid #cbd5e1;padding:5px;text-align:left;vertical-align:top}b,strong{font-weight:800}.observation{font-weight:800}.explanation{font-weight:normal}@media screen{body{max-width:800px;margin:32px auto;padding:0 24px}.cover{border-radius:10px}}</style></head><body>${cover}<h1>${escapeHtml(heading)}: ${escapeHtml(report.title)}</h1><p class="meta">${labels.report} ID: ${escapeHtml(report.reportNumber)} · Case: ${escapeHtml(report.caseNumber)} · ${labels.analysisDate}: ${escapeHtml(formatTimelineDate(simpleReport.analysisDate))}</p>${body}${custodyHtml}${signatureSection}<p class="meta">Generated ${escapeHtml(formatTimelineDate(report.createdAt))}. Technical assessment only; automated observations do not establish legal authenticity.</p><script>window.addEventListener('load',()=>window.print())</script></body></html>`;
}

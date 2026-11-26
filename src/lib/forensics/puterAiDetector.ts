export type PuterImageAssessment =
  | 'possible_ai_generated'
  | 'camera_consistent'
  | 'possible_ai_assisted_editing'
  | 'inconclusive';
export type PuterVisualAssessment = PuterImageAssessment;

export type PuterObservationStrength = 'Low' | 'Moderate' | 'Strong';

export interface PuterImageObservation {
  title: string;
  explanation: string;
  evidenceLevel: PuterObservationStrength;
  affectedRegion: string | null;
}

export interface PuterRequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  costMicrocents?: number;
}

export interface PuterTokenProgress {
  estimatedOutputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  isExact: boolean;
}

export interface PuterVisualAssessmentResult {
  investigationId: string;
  evidenceId: string;
  fileName: string;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  assessment: PuterImageAssessment;
  observations: PuterImageObservation[];
  modelId: string;
  modelName: string;
  modelVersion: string;
  provider: string;
  usage: PuterRequestUsage;
  timestamp: string;
  processingStatus: 'completed';
  limitations: string[];
}

export interface PuterMonthlyUsage {
  allowanceMicrocents?: number;
  remainingMicrocents?: number;
  usedMicrocents?: number;
  appRequestCount?: number;
  appResourcesMicrocents?: number;
  aiRequestCount?: number;
  apiUsage: Array<{ name: string; count?: number; costMicrocents?: number }>;
  refreshedAt: string;
}

export interface PuterModel {
  id: string;
  provider: string;
  name?: string;
  [key: string]: unknown;
}

export type PuterImageInputSupport = 'supported' | 'unsupported' | 'unknown';

export interface PuterModelOption {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  imageInputSupport: PuterImageInputSupport;
}

interface PuterApi {
  ai?: {
    chat?: (
      prompt: string,
      media: string | File,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    listModels?: () => Promise<unknown>;
  };
  auth?: {
    isSignedIn?: () => boolean;
    signIn?: (options?: { request_auth?: boolean; attempt_temp_user_creation?: boolean }) => Promise<unknown>;
    getMonthlyUsage?: () => Promise<unknown>;
  };
}

type WindowWithPuter = Window & { puter?: PuterApi };

const IMAGE_MODEL_PROMPT = `Examine the attached image itself and provide a cautious visual assessment of whether it appears more consistent with ordinary camera photography, possible AI generation, or possible AI-assisted editing. This is an experimental visual-language-model review, not a validated forensic detector.

Choose exactly one assessment:
- possible_ai_generated
- camera_consistent
- possible_ai_assisted_editing
- inconclusive

Only describe details actually visible in this image. Consider faces, backgrounds, textures, object details, repeated patterns, lighting, shadows, edges, blending, and possible mixed camera/AI content. Do not treat polish, style, compression, missing metadata, or lack of a camera look as proof of AI. Do not infer identity, age, or gender. Do not claim provenance, authenticity, or certainty.

Return JSON only with this shape:
{
  "assessment": "one of the four categories above",
  "observations": [
    {
      "title": "short plain-English title",
      "explanation": "one short sentence describing visible evidence",
      "evidenceLevel": "Low, Moderate, or Strong",
      "affectedRegion": "plain-English location or null"
    }
  ]
}

Provide 3 to 6 distinct observations when the image supports them. If visual evidence is insufficient, use inconclusive and include no observations rather than inventing details. Evidence level describes support for that individual visible observation only; it is not an AI-generation probability. Do not return percentages, scores, or technical jargon.`;

const LIMITATIONS = [
  'This is an experimental visual-language-model assessment, not a validated forensic AI detector.',
  'Visual characteristics alone cannot prove whether an image is AI-generated, original, or authentic.',
  'Compression, resizing, editing, lighting, and image quality can affect visible details.',
];

const CATEGORY_VALUES: PuterImageAssessment[] = [
  'possible_ai_generated',
  'camera_consistent',
  'possible_ai_assisted_editing',
  'inconclusive',
];
const EVIDENCE_LEVELS: PuterObservationStrength[] = ['Low', 'Moderate', 'Strong'];
const IMAGE_MODEL_PROVIDERS = new Set(['google', 'openai', 'claude', 'anthropic']);
const PREFERRED_MODEL_ID = 'gpt-5.4-nano';

function getPuter(): PuterApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as WindowWithPuter).puter;
}

export function isPuterAvailable(): boolean {
  return typeof getPuter()?.ai?.chat === 'function';
}

export function isPuterSignedIn(): boolean {
  try {
    return getPuter()?.auth?.isSignedIn?.() === true;
  } catch {
    return false;
  }
}

export async function connectPuterAccount(): Promise<void> {
  const auth = getPuter()?.auth;
  if (!auth?.signIn) {
    throw new Error('Puter sign-in is unavailable. Check the connection to js.puter.com and reload the app.');
  }
  await auth.signIn();
}

export async function requestPuterAccountSwitch(): Promise<void> {
  const auth = getPuter()?.auth;
  if (!auth?.signIn) {
    throw new Error('Puter sign-in is unavailable. Check the connection to js.puter.com and reload the app.');
  }
  await auth.signIn({ request_auth: true });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function sumNumericValues(value: unknown, key: 'count' | 'total'): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const values = Object.values(record)
    .map((entry) => firstNumber(asRecord(entry)?.[key]))
    .filter((entry): entry is number => entry !== undefined);
  return values.length ? values.reduce((total, entry) => total + entry, 0) : undefined;
}

export function formatPuterMicrocents(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  }).format(amount / 100_000_000);
}

function getImageInputSupport(model: PuterModel): PuterImageInputSupport {
  const modality = model.input_modalities ?? model.inputModalities ?? model.modalities;
  if (Array.isArray(modality)) {
    return modality.some((entry) => typeof entry === 'string' && /image|vision/i.test(entry))
      ? 'supported'
      : 'unsupported';
  }
  if (typeof modality === 'string') {
    if (/image|vision/i.test(modality)) return 'supported';
    if (modality.trim()) return 'unsupported';
  }

  for (const key of ['supportsImage', 'supports_image', 'supportsVision', 'supports_vision']) {
    if (typeof model[key] === 'boolean') return model[key] ? 'supported' : 'unsupported';
  }

  const capabilities = asRecord(model.capabilities);
  if (capabilities) {
    const imageSupport = capabilities.image ?? capabilities.images ?? capabilities.vision;
    if (typeof imageSupport === 'boolean') return imageSupport ? 'supported' : 'unsupported';
    if (Array.isArray(imageSupport)) return imageSupport.length ? 'supported' : 'unsupported';
  }

  return 'unknown';
}

export async function listPuterModels(): Promise<PuterModelOption[]> {
  const listModels = getPuter()?.ai?.listModels;
  if (!listModels) throw new Error('Puter model list is unavailable. Check your connection and reload the app.');

  const catalog = await listModels();
  if (!Array.isArray(catalog)) throw new Error('Puter returned an invalid model list.');

  const options = catalog.flatMap((entry): PuterModelOption[] => {
    const value = asRecord(entry);
    if (!value || typeof value.id !== 'string' || !value.id.trim()) return [];
    if (typeof value.provider !== 'string' || !IMAGE_MODEL_PROVIDERS.has(value.provider.trim().toLowerCase())) return [];
    const id = value.id.trim();
    const model = value as unknown as PuterModel;
    const imageInputSupport = getImageInputSupport(model);
    if (imageInputSupport === 'unsupported') return [];
    return [{
      id,
      modelId: id,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
      provider: value.provider.trim(),
      imageInputSupport,
    }];
  });

  return [...new Map(options.map((model) => [model.modelId, model])).values()]
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name)
    );
}

export function getDefaultPuterModel(models: PuterModelOption[]): PuterModelOption | undefined {
  return models.find((model) =>
    model.provider.toLowerCase() === 'openai' && model.modelId.toLowerCase().endsWith(PREFERRED_MODEL_ID)
  ) ?? models.find((model) => model.imageInputSupport === 'supported')
    ?? models[0];
}

export async function getPuterMonthlyUsage(): Promise<PuterMonthlyUsage> {
  const auth = getPuter()?.auth;
  if (!auth?.getMonthlyUsage) throw new Error('Puter usage information is unavailable.');

  const value = asRecord(await auth.getMonthlyUsage());
  if (!value) throw new Error('Puter returned invalid monthly usage information.');
  const allowanceInfo = asRecord(value.allowanceInfo);
  const allowance = firstNumber(allowanceInfo?.monthUsageAllowance);
  const remaining = firstNumber(allowanceInfo?.remaining);
  const usage = asRecord(value.usage);
  const apiUsage = usage
    ? Object.entries(usage).map(([name, entry]) => {
      const item = asRecord(entry);
      return {
        name,
        count: firstNumber(item?.count),
        costMicrocents: firstNumber(item?.cost),
      };
    })
    : [];
  const aiCounts = apiUsage
    .filter((item) => /(?:^|[._/])ai(?:[._/]|$)|chat|completion/i.test(item.name))
    .map((item) => item.count)
    .filter((count): count is number => count !== undefined);

  return {
    allowanceMicrocents: allowance,
    remainingMicrocents: remaining,
    usedMicrocents: allowance !== undefined && remaining !== undefined
      ? Math.max(0, allowance - remaining)
      : undefined,
    appRequestCount: sumNumericValues(value.appTotals, 'count'),
    appResourcesMicrocents: sumNumericValues(value.appTotals, 'total'),
    aiRequestCount: aiCounts.length ? aiCounts.reduce((total, count) => total + count, 0) : undefined,
    apiUsage,
    refreshedAt: new Date().toISOString(),
  };
}

export async function loadOriginalImageFile(
  sourceUrl: string,
  fileName: string,
  mimeType: string,
): Promise<File> {
  if (!sourceUrl) throw new Error('The original evidence image is unavailable. Re-upload the original file and try again.');
  let response: Response;
  try {
    response = await fetch(sourceUrl);
  } catch {
    throw new Error('The original image could not be downloaded for analysis. Re-upload the original evidence file.');
  }
  if (!response.ok) throw new Error(`The original image could not be loaded (HTTP ${response.status}).`);

  const blob = await response.blob();
  const type = blob.type.startsWith('image/')
    ? blob.type
    : mimeType.startsWith('image/') ? mimeType : blob.type;
  if (!type.startsWith('image/')) throw new Error('The selected evidence is not a supported image file.');
  if (blob.size === 0) throw new Error('The selected evidence image is empty.');
  return new File([blob], fileName, { type });
}

async function hashFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser; the image was not sent.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('The evidence file is not a readable image. No AI request was sent.');
  }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('The image has invalid dimensions. No AI request was sent.');
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function extractText(response: unknown): string {
  const value = asRecord(response);
  if (typeof response === 'string') return response;
  if (typeof value?.text === 'string') return value.text;
  const content = asRecord(value?.message)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => asRecord(part)?.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n');
  }
  return '';
}

function parseAssessment(text: string): Pick<PuterVisualAssessmentResult, 'assessment' | 'observations'> {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Puter returned an unreadable assessment.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error('Puter returned invalid JSON for its assessment.');
  }
  const result = asRecord(parsed);
  if (!result || !CATEGORY_VALUES.includes(result.assessment as PuterImageAssessment)) {
    throw new Error('Puter returned an unsupported assessment category.');
  }
  if (!Array.isArray(result.observations) || result.observations.length > 6) {
    throw new Error('Puter returned invalid visual observations.');
  }

  const observations = result.observations.map((observation) => {
    const item = asRecord(observation);
    if (
      typeof item?.title !== 'string' ||
      typeof item.explanation !== 'string' ||
      !EVIDENCE_LEVELS.includes(item.evidenceLevel as PuterObservationStrength) ||
      (item.affectedRegion !== null && typeof item.affectedRegion !== 'string')
    ) {
      throw new Error('Puter returned an invalid observation. No result was saved.');
    }
    return {
      title: item.title.trim().slice(0, 80),
      explanation: item.explanation.trim().slice(0, 300),
      evidenceLevel: item.evidenceLevel as PuterObservationStrength,
      affectedRegion: typeof item.affectedRegion === 'string' ? item.affectedRegion.trim().slice(0, 120) : null,
    };
  });
  const assessment = result.assessment as PuterImageAssessment;
  if (assessment !== 'inconclusive' && observations.length < 3) {
    throw new Error('Puter returned fewer than three supported observations. The assessment was not saved.');
  }
  if (observations.some((item) => !item.title || !item.explanation)) {
    throw new Error('Puter returned an empty observation. No result was saved.');
  }
  return { assessment, observations };
}

function extractUsage(response: unknown): PuterRequestUsage {
  const value = asRecord(response);
  const usage = asRecord(value?.usage);
  const details = asRecord(value?.usageDetails);
  const inputTokens = firstNumber(
    details?.inputTokens,
    usage?.prompt_tokens,
    usage?.input_tokens,
    usage?.inputTokens,
  );
  const outputTokens = firstNumber(
    details?.outputTokens,
    usage?.completion_tokens,
    usage?.output_tokens,
    usage?.outputTokens,
  );
  const costMicrocents = firstNumber(usage?.cost);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costMicrocents === undefined ? {} : { costMicrocents }),
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function estimateOutputTokens(text: string): number {
  // Puter emits exact token totals only at the end; use a clearly labeled character-based estimate while streaming.
  return Math.ceil(text.length / 4);
}

async function collectPuterResponse(
  response: unknown,
  onTokenProgress?: (progress: PuterTokenProgress) => void,
): Promise<{ text: string; usage: PuterRequestUsage; metadata: Record<string, unknown> | null }> {
  if (!isAsyncIterable(response)) {
    const text = extractText(response);
    const usage = extractUsage(response);
    onTokenProgress?.({
      estimatedOutputTokens: estimateOutputTokens(text),
      ...usage,
      isExact: usage.inputTokens !== undefined || usage.outputTokens !== undefined,
    });
    return { text, usage, metadata: asRecord(response) };
  }

  let text = '';
  let usage: PuterRequestUsage = {};
  for await (const chunk of response) {
    const item = asRecord(chunk);
    if (item?.type === 'error') {
      const code = typeof item.code === 'string' ? item.code : 'Puter stream error';
      const message = typeof item.message === 'string' ? item.message : 'The Puter stream failed.';
      throw new Error(`${code}: ${message}`);
    }

    if (item?.type === 'text' && typeof item.text === 'string') {
      text += item.text;
      onTokenProgress?.({
        estimatedOutputTokens: estimateOutputTokens(text),
        isExact: false,
      });
    } else if (item?.type === 'usage') {
      usage = extractUsage(chunk);
      onTokenProgress?.({
        estimatedOutputTokens: estimateOutputTokens(text),
        ...usage,
        isExact: usage.inputTokens !== undefined || usage.outputTokens !== undefined,
      });
    }
  }

  return { text, usage, metadata: null };
}

export function formatPuterError(error: unknown): string {
  const value = asRecord(error);
  const code = String(value?.code || value?.error || '');
  const message = error instanceof Error ? error.message : String(value?.msg || value?.message || error);
  const detail = `${code} ${message}`.toLowerCase();
  if (/^(the original|the selected evidence|the evidence file|sha-256|the image has)/i.test(message)) {
    return message;
  }
  if (/popup_blocked/.test(detail)) return 'The Puter sign-in window was blocked. Allow pop-ups and try again.';
  if (/auth_window_closed/.test(detail)) return 'Puter sign-in was cancelled. Connect your account to continue.';
  if (/unsupported_origin/.test(detail)) return 'Open VexaLens from its local web address or deployed site before connecting Puter.';
  if (/sign-in did not complete/.test(detail)) return 'Puter sign-in did not complete. Please try again.';
  if (/low.?balance|insufficient|not.{0,12}enough.{0,12}fund|allowance.*(exhaust|used)|monthly.*limit/.test(detail)) {
    return 'Puter reports that this account has insufficient balance for the selected request. Switch to an account with usable Puter funds or choose a model the account can run; VexaLens cannot add Puter funds.';
  }
  if (/auth|sign.?in|unauthorized|not_authenticated/.test(detail)) {
    return 'Please connect your Puter account to continue.';
  }
  if (/rate.?limit|too many requests|429/.test(detail)) {
    return 'Puter is receiving too many requests. Wait a little and try again.';
  }
  if (/unsupported.?model|model.*not found|unknown model/.test(detail)) {
    return 'Puter could not run the selected model for this account. Choose another available image model and try again.';
  }
  if (/invalid.?image|image upload|unsupported image|media.*format/.test(detail)) {
    return 'Puter could not accept this image format. Use a standard JPEG, PNG, or WebP evidence image.';
  }
  if (/timeout|timed out|request_timeout/.test(detail)) {
    return 'The analysis timed out. No result was produced; try again.';
  }
  if (/network|fetch|connection|offline/.test(detail)) {
    return 'The AI service could not be reached. Check your connection and try again.';
  }
  return 'The AI service could not complete this assessment. No result was saved.';
}

export async function analyzeWithPuterAI(
  file: File,
  investigationId: string,
  evidenceId: string,
  selectedModel: PuterModelOption,
  expectedSha256?: string,
  signal?: AbortSignal,
  onTokenProgress?: (progress: PuterTokenProgress) => void,
): Promise<PuterVisualAssessmentResult> {
  const puter = getPuter();
  if (!puter?.ai?.chat) throw new Error('Puter AI is unavailable. Check the connection to js.puter.com and reload the app.');

  const [sha256, dimensions] = await Promise.all([
    hashFile(file),
    getImageDimensions(file),
  ]);
  if (expectedSha256 && /^[a-f\d]{64}$/i.test(expectedSha256) && sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('The original image SHA-256 does not match the evidence record. No AI request was sent.');
  }

  let response: { text: string; usage: PuterRequestUsage; metadata: Record<string, unknown> | null };
  try {
    const rawResponse = await puter.ai.chat(IMAGE_MODEL_PROMPT, file, {
      model: selectedModel.modelId,
      fallback: false,
      max_tokens: 1200,
      temperature: 0.2,
      signal,
      stream: true,
    });
    response = await collectPuterResponse(rawResponse, onTokenProgress);
  } catch (error) {
    throw new Error(formatPuterError(error));
  }

  const parsed = parseAssessment(response.text);
  const responseRecord = response.metadata;
  const returnedModel = typeof responseRecord?.model === 'string' ? responseRecord.model : selectedModel.modelId;
  const returnedProvider = typeof responseRecord?.provider === 'string' ? responseRecord.provider : selectedModel.provider;
  return {
    investigationId,
    evidenceId,
    fileName: file.name,
    sha256,
    mimeType: file.type,
    width: dimensions.width,
    height: dimensions.height,
    ...parsed,
    modelId: returnedModel,
    modelName: selectedModel.name,
    modelVersion: returnedModel,
    provider: returnedProvider,
    usage: response.usage,
    timestamp: new Date().toISOString(),
    processingStatus: 'completed',
    limitations: LIMITATIONS,
  };
}

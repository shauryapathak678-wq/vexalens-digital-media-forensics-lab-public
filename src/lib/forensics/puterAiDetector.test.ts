import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './puterAiDetector';

type TestPuter = {
  ai?: {
    chat?: (...args: unknown[]) => Promise<unknown>;
    listModels?: () => Promise<unknown>;
  };
  auth?: {
    isSignedIn?: () => boolean;
    signIn?: () => Promise<unknown>;
    getMonthlyUsage?: () => Promise<unknown>;
  };
};

const testWindow = {} as Window & { puter?: TestPuter };
const imageAssessment = {
  assessment: 'possible_ai_generated',
  observations: [
    { title: 'Uneven texture', explanation: 'A small area has a different texture from nearby surfaces.', evidenceLevel: 'Moderate', affectedRegion: 'Upper background' },
    { title: 'Soft edge', explanation: 'One object edge appears softer than the surrounding edges.', evidenceLevel: 'Low', affectedRegion: 'Right side' },
    { title: 'Light direction', explanation: 'The visible shadows do not point in the same direction.', evidenceLevel: 'Low', affectedRegion: null },
  ],
};
const testModel = {
  id: 'gpt-5.4-nano',
  modelId: 'gpt-5.4-nano',
  name: 'GPT-5.4 Nano',
  provider: 'openai',
  imageInputSupport: 'supported' as const,
};

function makeFile(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'evidence.png', { type: 'image/png' });
}

describe('Puter AI Image Detection', () => {
  beforeEach(() => {
    vi.stubGlobal('window', testWindow);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 640,
      height: 480,
      close: vi.fn(),
    })));
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(1).buffer),
      },
    });
    delete testWindow.puter;
  });

  afterEach(() => {
    delete testWindow.puter;
    vi.unstubAllGlobals();
  });

  it('sends the original image to the selected Puter image model using its catalog ID', async () => {
    const file = makeFile();
    const chat = vi.fn().mockResolvedValue({
      message: { content: JSON.stringify(imageAssessment) },
      model: 'gpt-5.4-nano',
      provider: 'openai',
      usageDetails: { inputTokens: 318, outputTokens: 143 },
      usage: { cost: 1200 },
    });
    testWindow.puter = {
      ai: { chat },
    };

    const result = await analyzeWithPuterAI(
      file,
      'investigation-1',
      'evidence-1',
      testModel,
      '01'.repeat(32),
    );

    expect(chat).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledWith(
      expect.stringContaining('Only describe details actually visible'),
      file,
      expect.objectContaining({
        model: 'gpt-5.4-nano',
        fallback: false,
        stream: true,
      }),
    );
    expect(result.assessment).toBe('possible_ai_generated');
    expect(result.observations).toHaveLength(3);
    expect(result.modelId).toBe('gpt-5.4-nano');
    expect(result.modelName).toBe('GPT-5.4 Nano');
    expect(result.provider).toBe('openai');
    expect(result.usage).toEqual({ inputTokens: 318, outputTokens: 143, costMicrocents: 1200 });
    expect(result.sha256).toBe('01'.repeat(32));
    expect(result).not.toHaveProperty('confidence');
  });

  it('updates estimated streamed tokens and then replaces them with Puter exact totals', async () => {
    const text = JSON.stringify(imageAssessment);
    const chat = vi.fn().mockResolvedValue((async function* () {
      yield { type: 'text', text: text.slice(0, 20) };
      yield { type: 'text', text: text.slice(20) };
      yield {
        type: 'usage',
        usage: { prompt_tokens: 123, completion_tokens: 45, cost: 1200 },
        usageDetails: { inputTokens: 123, outputTokens: 45 },
      };
    })());
    const onTokenProgress = vi.fn();
    testWindow.puter = { ai: { chat } };

    const result = await analyzeWithPuterAI(
      makeFile(),
      'investigation-1',
      'evidence-1',
      testModel,
      undefined,
      undefined,
      onTokenProgress,
    );

    expect(onTokenProgress).toHaveBeenNthCalledWith(1, {
      estimatedOutputTokens: 5,
      isExact: false,
    });
    expect(onTokenProgress).toHaveBeenLastCalledWith({
      estimatedOutputTokens: Math.ceil(text.length / 4),
      inputTokens: 123,
      outputTokens: 45,
      costMicrocents: 1200,
      isExact: true,
    });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45, costMicrocents: 1200 });
  });

  it('surfaces errors sent as Puter stream chunks', async () => {
    const chat = vi.fn().mockResolvedValue((async function* () {
      yield { type: 'error', code: 'low_balance', message: 'Your account does not have enough funding.' };
    })());
    testWindow.puter = { ai: { chat } };

    await expect(analyzeWithPuterAI(makeFile(), 'case', 'evidence', testModel))
      .rejects.toThrow('insufficient balance');
  });

  it('lists image-capable Google, OpenAI, and Claude models using their exact Puter IDs', async () => {
    testWindow.puter = {
      ai: {
        listModels: vi.fn().mockResolvedValue([
          { id: 'gpt-5.4-nano', provider: 'openai', name: 'GPT-5.4 Nano', input_modalities: ['text', 'image'] },
          { id: 'gemini-3.8-flash', provider: 'google', name: 'Gemini 3.8 Flash', input_modalities: ['text', 'image'] },
          { id: 'claude-sonnet-4-5', provider: 'claude', name: 'Claude Sonnet 4.5', supports_vision: true },
          { id: 'gpt-text-only', provider: 'openai', name: 'Text Model', input_modalities: ['text'] },
          { id: 'deepseek-vision', provider: 'deepseek', name: 'Other Provider Vision', input_modalities: ['text', 'image'] },
        ]),
      },
    };

    const models = await listPuterModels();

    expect(models.map(({ modelId, provider }) => [modelId, provider])).toEqual([
      ['claude-sonnet-4-5', 'claude'],
      ['gemini-3.8-flash', 'google'],
      ['gpt-5.4-nano', 'openai'],
    ]);
    expect(getDefaultPuterModel(models)?.modelId).toBe('gpt-5.4-nano');
  });

  it('wraps downloaded original bytes without resizing or changing the image content', async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([sourceBytes], { type: 'image/jpeg' }),
    }));

    const file = await loadOriginalImageFile('https://evidence.test/original.jpg', 'original.jpg', 'image/jpeg');

    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(sourceBytes));
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('original.jpg');
  });

  it('refuses to send an image when its bytes do not match the recorded evidence hash', async () => {
    const chat = vi.fn();
    testWindow.puter = {
      ai: { chat },
    };

    await expect(analyzeWithPuterAI(makeFile(), 'case', 'evidence', testModel, '00'.repeat(32)))
      .rejects.toThrow('SHA-256 does not match');
    expect(chat).not.toHaveBeenCalled();
  });

  it('surfaces provider rejection instead of producing a result when the configured model cannot run', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('model unavailable'));
    testWindow.puter = { ai: { chat } };

    await expect(analyzeWithPuterAI(makeFile(), 'case', 'evidence', testModel))
      .rejects.toThrow('AI service could not complete this assessment');
    expect(chat).toHaveBeenCalledOnce();
  });

  it('rejects malformed provider output instead of creating a result', async () => {
    testWindow.puter = {
      ai: {
        chat: vi.fn().mockResolvedValue({ message: { content: 'not JSON' } }),
      },
    };

    await expect(analyzeWithPuterAI(makeFile(), 'case', 'evidence', testModel))
      .rejects.toThrow('unreadable assessment');
  });

  it('reports the live allowance, app usage, and AI request usage without invented balances', async () => {
    testWindow.puter = {
      auth: {
        getMonthlyUsage: vi.fn().mockResolvedValue({
          allowanceInfo: { monthUsageAllowance: 2_000_000, remaining: 1_250_000 },
          appTotals: { 'vexalens-app': { count: 4, total: 750_000 } },
          usage: { 'ai.chat': { count: 3, cost: 750_000 }, 'fs.read': { count: 1, cost: 100 } },
        }),
      },
    };

    await expect(getPuterMonthlyUsage()).resolves.toMatchObject({
      allowanceMicrocents: 2_000_000,
      remainingMicrocents: 1_250_000,
      usedMicrocents: 750_000,
      appRequestCount: 4,
      appResourcesMicrocents: 750_000,
      aiRequestCount: 3,
    });
  });

  it('displays small nonzero Puter balances without rounding them to zero', () => {
    expect(formatPuterMicrocents(0)).toBe('$0.0000');
    expect(formatPuterMicrocents(1)).toBe('$0.00000001');
    expect(formatPuterMicrocents(1_200)).toBe('$0.000012');
  });

  it('explains Puter low-balance errors without implying VexaLens can add funds', () => {
    const message = formatPuterError(new Error(
      'Low Balance: Your account does not have enough funding to complete this request. Please upgrade to continue.',
    ));

    expect(message).toContain('insufficient balance');
    expect(message).toContain('VexaLens cannot add Puter funds');
  });

  it('supports Puter sign-in and reads the actual connection state', async () => {
    const signIn = vi.fn().mockResolvedValue({ success: true });
    let signedIn = false;
    testWindow.puter = {
      auth: {
        signIn,
        isSignedIn: () => signedIn,
      },
      ai: { chat: vi.fn() },
    };

    expect(isPuterAvailable()).toBe(true);
    expect(isPuterSignedIn()).toBe(false);
    await connectPuterAccount();
    signedIn = true;
    expect(signIn).toHaveBeenCalledOnce();
    expect(isPuterSignedIn()).toBe(true);
  });
});

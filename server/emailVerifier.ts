import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const MAX_PROCESS_OUTPUT_BYTES = 45 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;

export interface EmailVerifierInput {
  screenshot?: Buffer;
  eml?: Buffer;
  emailFormat?: 'eml' | 'msg';
}

interface OcrWord {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
  lineKey: string;
}

interface OcrLine {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

interface OcrResult {
  status: 'complete' | 'no_text' | 'unavailable';
  reason: string | null;
  text: string;
  lines: OcrLine[];
  words: OcrWord[];
}

async function extractScreenshotOcr(_screenshot: Buffer): Promise<OcrResult | null> {
  return null;
}

export async function runEmailVerifier(input: EmailVerifierInput): Promise<Record<string, unknown>> {
  let precomputedOcr: OcrResult | null = null;
  if (input.screenshot && input.screenshot.length > 0) {
    try {
      precomputedOcr = await extractScreenshotOcr(input.screenshot);
    } catch (e) {
      console.warn('[EmailVerifier] Screenshot OCR precomputation failed:', e);
    }
  }

  const scriptPath = path.resolve(currentDirectory, '..', 'backend', 'email_verifier.py');
  const executable = process.env.SCREENSHOT_PYTHON_EXECUTABLE?.trim()
    || process.env.PYTHON_EXECUTABLE?.trim()
    || 'python';
  const child = spawn(executable, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      GOOGLE_CLOUD_VISION_API_KEY: process.env.GOOGLE_CLOUD_VISION_API_KEY || '',
    },
  });

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Email analysis exceeded the 45-second processing limit.'));
    }, PROCESS_TIMEOUT_MS);

    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Email analysis returned no result.'));
    };

    child.once('error', (error) => finish(new Error(
      `Could not start Python email analysis. Configure SCREENSHOT_PYTHON_EXECUTABLE. ${error.message}`
    )));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Email analysis output exceeded the processing limit.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorBytes >= 16_000) return;
      const boundedChunk = chunk.subarray(0, 16_000 - errorBytes);
      stderr.push(boundedChunk);
      errorBytes += boundedChunk.length;
    });
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const processError = Buffer.concat(stderr).toString('utf8').trim().slice(0, 1000);
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(output) as Record<string, unknown>;
      } catch {
        finish(new Error(code === 0
          ? 'Email analysis returned invalid JSON.'
          : processError || `Email analysis process failed (exit code ${code}).`));
        return;
      }
      if (code !== 0 || typeof result.error === 'string') {
        const error = new Error(
          typeof result.error === 'string'
            ? result.error
            : processError || `Email analysis process failed (exit code ${code}).`
        );
        if (result.errorType === 'InputError') error.name = 'EmailVerifierInputError';
        finish(error);
        return;
      }
      finish(undefined, result);
    });

    const payload = JSON.stringify({
      screenshot: input.screenshot?.toString('base64') ?? null,
      eml: input.eml?.toString('base64') ?? null,
      emailFormat: input.emailFormat || 'eml',
      ocr: precomputedOcr,
    });
    child.stdin.once('error', () => finish(new Error('Could not send evidence to the local analysis process.')));
    child.stdin.end(payload);
  });
}

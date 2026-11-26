import { isSupabaseConfigured } from '@/lib/supabase';
import { syncSavePuterImageDetection } from '@/lib/supabase-sync';
import type { PuterVisualAssessmentResult } from './puterAiDetector';

const STORAGE_KEY = 'vexalens_puter_image_detection_results';

export interface PuterDetectionSaveStatus {
  localSaved: true;
  remoteSaved: boolean;
  message: string;
}

function getLocalResults(): PuterVisualAssessmentResult[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Saved AI Image Detection history could not be read: ${detail}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Saved AI Image Detection history is invalid.');
  return parsed as PuterVisualAssessmentResult[];
}

export async function savePuterImageDetectionResult(
  result: PuterVisualAssessmentResult,
): Promise<PuterDetectionSaveStatus> {
  const existing = getLocalResults();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([result, ...existing]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The AI assessment completed, but its local evidence record could not be saved: ${detail}`);
  }

  if (!isSupabaseConfigured()) {
    return {
      localSaved: true,
      remoteSaved: false,
      message: 'Saved to this browser only. Configure and sign in to Supabase to save the structured result to the cloud database.',
    };
  }

  try {
    const saved = await syncSavePuterImageDetection(result);
    if (saved) {
      return { localSaved: true, remoteSaved: true, message: 'Saved locally and to the investigation database.' };
    }
    return {
      localSaved: true,
      remoteSaved: false,
      message: 'Saved locally. Sign in to Supabase to add this result to the remote investigation database.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      localSaved: true,
      remoteSaved: false,
      message: `Saved locally, but the database sync failed: ${detail}`,
    };
  }
}

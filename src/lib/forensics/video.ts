import { calculateSHA256 } from './crypto';

export interface ExtractedFrame {
  index: number;
  timeSec: number;
  formattedTime: string;
  dataUrl: string;
  sha256: string;
  width: number;
  height: number;
}

export interface VideoForensicAnalysis {
  durationSec: number;
  width: number;
  height: number;
  aspectRatio: string;
  frames: ExtractedFrame[];
}

/**
 * Extracts keyframes from a video file, computes per-frame SHA-256 hashes,
 * and provides frame-level forensic review capabilities.
 */
export async function extractVideoKeyframes(
  videoSourceUrl: string,
  frameCount = 6
): Promise<VideoForensicAnalysis> {
  return new Promise((resolve, reject) => {
    if (!videoSourceUrl || typeof videoSourceUrl !== 'string') {
      reject(new Error('Invalid or empty video source URL'));
      return;
    }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';

    let isCompleted = false;

    const cleanup = () => {
      isCompleted = true;
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };

    const timeout = setTimeout(() => {
      if (!isCompleted) {
        cleanup();
        reject(new Error('Video keyframe extraction timed out'));
      }
    }, 10000);

    video.onerror = (e) => {
      if (isCompleted) return;
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Video format is not supported or failed to decode'));
    };

    video.onloadedmetadata = async () => {
      if (isCompleted) return;
      try {
        const duration = video.duration || 1;
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 360;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error('Canvas context unavailable for video keyframe extraction'));
          return;
        }

        const frames: ExtractedFrame[] = [];
        const interval = duration / (frameCount + 1);

        for (let i = 1; i <= frameCount; i++) {
          const targetTime = i * interval;
          video.currentTime = targetTime;

          await new Promise<void>((res) => {
            const onSeek = () => {
              video.removeEventListener('seeked', onSeek);
              res();
            };
            video.addEventListener('seeked', onSeek);
          });

          ctx.drawImage(video, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

          // Convert dataURL to Blob to compute cryptographic SHA-256
          const resBlob = await fetch(dataUrl).then((r) => r.blob());
          const sha256 = await calculateSHA256(resBlob);

          const mins = Math.floor(targetTime / 60);
          const secs = (targetTime % 60).toFixed(2);
          const formattedTime = `${mins}:${secs.padStart(5, '0')}`;

          frames.push({
            index: i,
            timeSec: targetTime,
            formattedTime,
            dataUrl,
            sha256,
            width,
            height,
          });
        }

        const aspectRatio = `${width}:${height}`;

        clearTimeout(timeout);
        cleanup();
        resolve({
          durationSec: duration,
          width,
          height,
          aspectRatio,
          frames,
        });
      } catch (err) {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      }
    };

    // Set src after handlers are registered
    try {
      video.src = videoSourceUrl;
    } catch (assignErr) {
      clearTimeout(timeout);
      cleanup();
      reject(assignErr);
    }
  });
}

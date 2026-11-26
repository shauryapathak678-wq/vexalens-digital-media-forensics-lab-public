/**
 * Durable image helper for forensic reports.
 *
 * Uploaded evidence is kept in memory as a session-scoped `blob:` URL. A blob
 * URL stops resolving after the page is reloaded, so a report reopened later
 * would show a broken image. Converting the file into a small base64 data URL
 * at intake keeps the visual record available across sessions.
 */

/**
 * Generates a small, durable base64 JPEG thumbnail from an image source.
 * Returns null when the image cannot be decoded so callers can fall back to
 * the session-scoped preview URL.
 */
export async function generateThumbnail(
  source: string | Blob | HTMLImageElement,
  maxWidth = 320,
  maxHeight = 240,
  quality = 0.7
): Promise<string | null> {
  if (typeof document === 'undefined') return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';

    const draw = () => {
      try {
        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;
        if (!naturalWidth || !naturalHeight) {
          resolve(null);
          return;
        }

        const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
        const width = Math.max(1, Math.round(naturalWidth * scale));
        const height = Math.max(1, Math.round(naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }

        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (error) {
        console.warn('Thumbnail generation failed:', error);
        resolve(null);
      }
    };

    image.onload = draw;
    image.onerror = () => resolve(null);

    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      if (typeof FileReader === 'undefined') {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        image.src = typeof reader.result === 'string' ? reader.result : '';
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(source);
      return;
    }

    if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
      if (source.complete && source.naturalWidth > 0) {
        image.src = source.src;
      } else {
        source.addEventListener('load', () => {
          image.src = source.src;
        }, { once: true });
        source.addEventListener('error', () => resolve(null), { once: true });
      }
      return;
    }

    image.src = source as string;
  });
}

export async function generateVideoThumbnail(
  source: Blob,
  maxWidth = 320,
  maxHeight = 240,
  quality = 0.65
): Promise<string | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null;

  let objectUrl: string;
  try {
    objectUrl = URL.createObjectURL(source);
  } catch {
    return null;
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objectUrl;

  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => finish(null), 8000);
    const finish = (thumbnail: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(thumbnail);
    };

    const capture = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      try {
        const scale = Math.min(1, maxWidth / video.videoWidth, maxHeight / video.videoHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          finish(null);
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', quality));
      } catch {
        finish(null);
      }
    };

    video.addEventListener('loadeddata', capture, { once: true });
    video.addEventListener('seeked', capture, { once: true });
    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener('loadedmetadata', () => {
      if (video.duration > 0.25) {
        try {
          video.currentTime = Math.min(0.25, video.duration / 2);
        } catch {
          finish(null);
        }
      }
    }, { once: true });
  });
}

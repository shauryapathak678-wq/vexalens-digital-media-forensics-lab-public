-- Keep the private evidence bucket aligned with every media type accepted by
-- the evidence intake form.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm'
]
where id = 'evidence';

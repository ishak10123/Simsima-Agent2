import { AppError } from './errors.js';
import { normalizeText } from './content.js';

export function parseYouTubePostUrl(value) {
  let url;
  try { url = new URL(value, 'https://www.youtube.com'); } catch { throw new AppError('invalid_post_url', 'رابط منشور YouTube غير صالح.'); }
  const match = /^\/post\/(Ug[A-Za-z0-9_-]{10,160})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname)
      || url.username || url.password || url.port || !match) {
    throw new AppError('invalid_post_url', 'لم يمكن تحديد رابط منشور YouTube.');
  }
  return { post_id: match[1], post_url: `https://www.youtube.com/post/${match[1]}` };
}

export function youtubePostFields(renderer) {
  if (!renderer || typeof renderer !== 'object') return null;
  const content = renderer.contentText;
  const attachment = renderer.backstageAttachment;
  return {
    post_id: renderer.postId,
    channel_id: renderer.authorEndpoint?.browseEndpoint?.browseId,
    text: content?.simpleText ?? (Array.isArray(content?.runs) ? content.runs.map(run => run.text ?? '').join('') : null),
    image_count: attachment?.backstageImageRenderer ? 1
      : Array.isArray(attachment?.postMultiImageRenderer?.images) ? attachment.postMultiImageRenderer.images.length
        : !attachment ? 0 : null,
  };
}

export function parseYouTubeCreateResponse(payload, draft) {
  const stack = [payload];
  const posts = new Map();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (typeof value.postId === 'string' && /^Ug[A-Za-z0-9_-]{10,160}$/.test(value.postId)) {
      const existing = posts.get(value.postId);
      if (!existing || value.contentText) posts.set(value.postId, value);
    }
    stack.push(...Object.values(value).filter(child => child && typeof child === 'object'));
  }
  if (posts.size !== 1) throw new AppError('youtube_publish_unverified', 'لم تُرجع YouTube معرّف منشور واحدًا يمكن التحقق منه. لا تعاود الإرسال.');
  const [renderer] = posts.values();
  const fields = youtubePostFields(renderer);
  if ((fields.channel_id && fields.channel_id !== draft.account)
      || (fields.text !== null && normalizeText(fields.text) !== draft.text)) {
    throw new AppError('published_content_mismatch', 'استجابة YouTube لا تطابق القناة أو النص المطلوب.');
  }
  return { ...parseYouTubePostUrl(`/post/${fields.post_id}`), evidence: {
    source: 'youtube_create_post_response', channel_verified: fields.channel_id === draft.account,
    text_verified: fields.text !== null, image_sha256: draft.image_sha256, permalink_verified: false,
  } };
}

export function isYouTubeCreateResponse(response) {
  try {
    const url = new URL(response.url());
    return ['www.youtube.com', 'youtube.com'].includes(url.hostname)
      && /\/youtubei\/v1\/backstage\/create_post$/.test(url.pathname)
      && response.request().method() === 'POST';
  } catch { return false; }
}

import { AppError } from './errors.js';
import { normalizeAccount, normalizeText } from './content.js';

export function parsePostUrl(value, expectedAccount) {
  let url;
  try { url = new URL(value, 'https://x.com'); } catch { throw new AppError('invalid_post_url', 'رابط المنشور غير صالح.'); }
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname)
      || url.username || url.password || url.port || !match || normalizeAccount(match[1]) !== expectedAccount) {
    throw new AppError('post_account_mismatch', 'رابط المنشور لا يطابق حساب المسودة.');
  }
  return { post_id: match[2], post_url: `https://x.com/${expectedAccount}/status/${match[2]}` };
}

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_m, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  })[name]);
}

export function parseCreateTweet(payload, draft) {
  let result = payload?.data?.create_tweet?.tweet_results?.result;
  if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;
  const author = result?.core?.user_results?.result;
  const handle = author?.core?.screen_name ?? author?.legacy?.screen_name;
  const id = result?.rest_id;
  let text = result?.legacy?.full_text;
  if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof text !== 'string' || typeof handle !== 'string') {
    throw new AppError('publish_unverified', 'لم تتضمن استجابة X معرّف المنشور ومحتواه وحسابه بصورة يمكن التحقق منها.');
  }
  for (const entity of result.legacy.entities?.urls ?? []) {
    if (entity.url && entity.expanded_url) text = text.split(entity.url).join(entity.expanded_url);
  }
  const media = result.legacy.extended_entities?.media ?? result.legacy.entities?.media ?? [];
  for (const item of media) if (item.url) text = text.split(item.url).join('');
  if (normalizeAccount(handle) !== draft.account || normalizeText(decodeEntities(text)) !== draft.text) {
    throw new AppError('published_content_mismatch', 'استجابة النشر لا تطابق الحساب أو النص المطلوب. يلزم التحقق من النتيجة.');
  }
  if (draft.image_sha256 ? media.length !== 1 || media[0].type !== 'photo' : media.length !== 0) {
    throw new AppError('published_media_mismatch', 'لا تطابق مرفقات المنشور المسودة المطلوبة. يلزم التحقق من النتيجة.');
  }
  return { ...parsePostUrl(`https://x.com/${handle}/status/${id}`, draft.account),
    evidence: { source: 'create_tweet_response', account_verified: true, text_verified: true,
      image_count: media.length, image_sha256: draft.image_sha256, permalink_verified: false } };
}

export function isMatchingCreateResponse(response, draft) {
  try {
    const url = new URL(response.url());
    if (url.hostname !== 'x.com' || !/\/graphql\/[^/]+\/CreateTweet$/.test(url.pathname)
        || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON();
    return typeof body?.variables?.tweet_text === 'string'
      && normalizeText(body.variables.tweet_text) === draft.text;
  } catch { return false; }
}

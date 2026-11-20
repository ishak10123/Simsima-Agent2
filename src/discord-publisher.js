import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError } from './errors.js';
import { normalizeText } from './content.js';

const snowflake = value => typeof value === 'string' && /^[0-9]{17,20}$/.test(value);

export function parseWebhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report without including the secret. */ }
  const parts = url?.pathname.match(/^\/api\/(?:v10\/)?webhooks\/([0-9]{17,20})\/([A-Za-z0-9._-]{20,250})\/?$/);
  if (!url || url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port
    || url.username || url.password || url.search || url.hash || !parts) {
    throw new AppError('invalid_discord_webhook', 'رابط Webhook غير صالح؛ استخدم الرابط المنسوخ من إعدادات Discord.');
  }
  return { id: parts[1], url: `https://discord.com/api/v10/webhooks/${parts[1]}/${parts[2]}` };
}

export class DiscordPublisher {
  constructor(config, { fetch = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetch;
    this.configPath = config.discordConfigPath ?? resolve(config.dataDir, 'discord.json');
  }

  async webhook({ optional = false } = {}) {
    let value = this.config.discordWebhookUrl;
    if (!value) {
      try { value = JSON.parse((await readFile(this.configPath, 'utf8')).replace(/^\uFEFF/, '')).webhook_url; }
      catch (error) {
        if (error.code !== 'ENOENT') throw new AppError('invalid_discord_config', 'تعذر قراءة إعداد Discord المحلي.', { path: this.configPath });
      }
    }
    if (!value) {
      if (optional) return null;
      throw new AppError('discord_not_configured', 'ضع رابط Webhook في ملف إعداد Discord المحلي أولًا.', { path: this.configPath });
    }
    return parseWebhookUrl(value);
  }

  async request(url, { method = 'GET', body, headers, signal } = {}) {
    try {
      const deadline = AbortSignal.timeout(this.config.timeoutMs ?? 30000);
      const response = await this.fetch(url, { method, body, headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) {
        let retryAfter;
        if (response.status === 429) {
          try { retryAfter = (await response.json()).retry_after; } catch { /* no raw response */ }
        }
        throw new AppError('discord_http_error', 'رفض Discord الطلب؛ لم تُجرَ إعادة إرسال تلقائية.', {
          http_status: response.status,
          ...(Number.isFinite(retryAfter) ? { retry_after_seconds: retryAfter } : {}),
          ...(method === 'POST' && [400, 401, 403, 404, 405, 413, 429].includes(response.status) ? { not_created: true } : {}),
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Native fetch errors and Discord response bodies can contain the webhook token.
      throw new AppError('discord_request_unverified', 'تعذر تأكيد استجابة Discord؛ لم تُجرَ إعادة إرسال تلقائية.');
    }
  }

  async metadata(webhook, signal) {
    const data = await this.request(webhook.url, { signal });
    if (data.id !== webhook.id || data.type !== 1 || !snowflake(data.channel_id) || !snowflake(data.guild_id)) {
      throw new AppError('invalid_discord_destination', 'يلزم Webhook وارد لقناة نصية داخل سيرفر Discord.');
    }
    return { webhook_id: data.id, guild_id: data.guild_id, channel_id: data.channel_id,
      name: typeof data.name === 'string' ? data.name : null };
  }

  async status() {
    const webhook = await this.webhook({ optional: true });
    if (!webhook) return { configured: false, config_path: this.configPath };
    const destination = await this.metadata(webhook);
    return { configured: true, ...destination,
      channel_url: `https://discord.com/channels/${destination.guild_id}/${destination.channel_id}` };
  }

  requireChannel(destination, draft) {
    if (destination.channel_id !== draft.account) {
      throw new AppError('discord_channel_mismatch', 'قناة Webhook لا تطابق قناة المسودة؛ لم يُرسل المنشور.');
    }
  }

  candidate(message, destination, draft) {
    if (!snowflake(message?.id) || message.channel_id !== draft.account || message.webhook_id !== destination.webhook_id) {
      throw new AppError('discord_message_unverified', 'تعذر مطابقة رسالة Discord مع الوجهة المطلوبة.');
    }
    return { post_id: message.id,
      post_url: `https://discord.com/channels/${destination.guild_id}/${draft.account}/${message.id}`,
      evidence: { channel_id: draft.account, guild_id: destination.guild_id, webhook_id: destination.webhook_id,
        image_sha256: draft.image_sha256, permalink_verified: false } };
  }

  verifyMessage(message, candidate, draft, destination) {
    const actual = this.candidate(message, destination, draft);
    const images = message.attachments;
    const filename = draft.image_mime === 'image/png' ? 'image.png' : 'image.jpg';
    if (actual.post_id !== candidate.post_id || actual.post_url !== candidate.post_url
      || typeof message.content !== 'string' || normalizeText(message.content) !== draft.text
      || !Array.isArray(images) || images.length !== (draft.image_sha256 ? 1 : 0)
      || (draft.image_sha256 && (images[0].filename !== filename || images[0].size !== draft.image_bytes.length
        || (images[0].content_type && images[0].content_type !== draft.image_mime)))) {
      throw new AppError('discord_content_mismatch', 'تعذر التحقق من نص Discord وصورته؛ لا تعاود النشر.');
    }
    return { ...actual, evidence: { ...actual.evidence, text_verified: true, image_verified: true,
      channel_verified: true, permalink_verified: true, verification_method: 'webhook_message_get' } };
  }

  async verifyExisting(candidate, draft, { signal, webhook, destination } = {}) {
    webhook ??= await this.webhook();
    destination ??= await this.metadata(webhook, signal);
    this.requireChannel(destination, draft);
    if (!snowflake(candidate.post_id)) throw new AppError('invalid_post_id', 'معرّف رسالة Discord غير صالح.');
    const message = await this.request(`${webhook.url}/messages/${candidate.post_id}`, { signal });
    return this.verifyMessage(message, candidate, draft, destination);
  }

  async publish(draft, { signal, onSubmitting, onAccepted }) {
    const webhook = await this.webhook();
    const destination = await this.metadata(webhook, signal);
    this.requireChannel(destination, draft);
    const payload = { content: draft.text, allowed_mentions: { parse: [] } };
    let body, headers;
    if (draft.image_sha256) {
      const filename = draft.image_mime === 'image/png' ? 'image.png' : 'image.jpg';
      payload.attachments = [{ id: 0, filename }];
      body = new FormData();
      body.set('payload_json', JSON.stringify(payload));
      body.set('files[0]', new Blob([draft.image_bytes], { type: draft.image_mime }), filename);
    } else {
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }
    signal?.throwIfAborted();
    await onSubmitting();
    // Exactly one POST. Timeouts and server errors remain uncertain in the ledger.
    const message = await this.request(`${webhook.url}?wait=true`, { method: 'POST', body, headers, signal });
    const candidate = this.candidate(message, destination, draft);
    await onAccepted(candidate);
    return this.verifyExisting(candidate, draft, { signal, webhook, destination });
  }
}

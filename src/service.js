import { Store } from './store.js';
import { HeadlessBraveConnection } from './browser.js';
import { XPublisher } from './x-publisher.js';
import { YouTubePublisher } from './youtube-publisher.js';
import { DiscordPublisher } from './discord-publisher.js';
import { AppError, errorResult } from './errors.js';
import { normalizeAccount, normalizeYouTubeChannel, normalizeDiscordChannel, readImage,
  validateText, validateYouTubeText, validateDiscordText } from './content.js';

export class AgentService {
  constructor(config, { store, connection, publisher, youtubePublisher, discordPublisher } = {}) {
    this.store = store ?? new Store(config.dataDir);
    this.connection = connection ?? new HeadlessBraveConnection(config);
    this.publisher = publisher ?? new XPublisher(this.connection, config);
    this.youtubePublisher = youtubePublisher ?? new YouTubePublisher(this.connection, config);
    this.discordPublisher = discordPublisher ?? new DiscordPublisher(config);
    this.pending = new Set();
  }

  browserStatus() { return this.connection.status(); }
  accountStatus() { return this.publisher.accountStatus(); }
  youtubeAccountStatus() { return this.youtubePublisher.accountStatus(); }
  discordStatus() { return this.discordPublisher.status(); }

  async preparePost({ text, account, image_path }) {
    const validated = validateText(text);
    const expected = normalizeAccount(account);
    const image = await readImage(image_path);
    return this.store.createDraft({ ...validated, account: expected, image });
  }

  async prepareYouTubePost({ text, channel_id, image_path }) {
    const validated = validateYouTubeText(text);
    const account = normalizeYouTubeChannel(channel_id);
    const image = await readImage(image_path);
    return this.store.createDraft({ ...validated, account, image, platform: 'youtube' });
  }

  async prepareDiscordPost({ text, channel_id, image_path }) {
    const validated = validateDiscordText(text);
    const account = normalizeDiscordChannel(channel_id);
    const image = await readImage(image_path);
    return this.store.createDraft({ ...validated, account, image, platform: 'discord' });
  }

  async publishPost(input, options = {}) {
    return this.publishOnPlatform('x', input, options);
  }

  async publishYouTubePost(input, options = {}) {
    return this.publishOnPlatform('youtube', input, options);
  }

  async publishDiscordPost(input, options = {}) {
    return this.publishOnPlatform('discord', input, options);
  }

  async publishOnPlatform(platform, input, options) {
    const job = this.executePublish(input, options, platform);
    this.pending.add(job);
    try { return await job; } finally { this.pending.delete(job); }
  }

  async executePublish({ draft_id, request_id }, { signal } = {}, platform = 'x') {
    if (typeof request_id !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(request_id)) {
      throw new AppError('invalid_request_id', 'استخدم معرّف عملية فريدًا من 8 إلى 120 حرفًا إنجليزيًا أو رقمًا أو _ . : -');
    }
    const draft = this.store.getDraft(draft_id);
    if (draft.platform !== platform) throw new AppError('platform_mismatch', 'هذه المسودة تخص منصة أخرى.');
    const claim = this.store.claim(request_id, draft_id);
    if (!claim.acquired) return { ...claim.operation, replayed: true };
    try {
      const publisher = { x: this.publisher, youtube: this.youtubePublisher, discord: this.discordPublisher }[platform];
      const result = await publisher.publish(draft, {
        signal,
        onSubmitting: () => this.store.markSubmitting(request_id),
        onAccepted: candidate => this.store.recordCandidate(request_id, candidate),
      });
      return this.store.finish(request_id, { result });
    } catch (error) {
      return this.store.finish(request_id, { error: errorResult(error),
        notCreated: platform === 'discord' && error instanceof AppError && error.details?.not_created === true });
    }
  }

  getOperation({ request_id }) { this.store.recover(); return this.store.getOperation(request_id); }

  async verifyOperation(input, { signal } = {}) {
    const job = this.executeVerify(input, signal);
    this.pending.add(job);
    try { return await job; } finally { this.pending.delete(job); }
  }

  async executeVerify(input, signal) {
    const operation = this.getOperation(input);
    if (operation.status !== 'uncertain' || !operation.post_id || !operation.post_url) return operation;
    const draft = this.store.getDraft(operation.draft_id);
    const candidate = { ...operation, evidence: operation.evidence ?? {} };
    let result;
    if (draft.platform === 'discord') result = await this.discordPublisher.verifyExisting(candidate, draft, { signal });
    else {
      const publisher = draft.platform === 'youtube' ? this.youtubePublisher : this.publisher;
      result = await this.connection.exclusive(() => this.connection.withPage(page => publisher.verifyPermalink(page, candidate, draft)));
    }
    return this.store.finish(operation.request_id, { result });
  }
  getDraft({ draft_id }) { return this.store.publicDraft(this.store.getDraft(draft_id)); }
  close() { this.store.close(); }
  async shutdown() { await Promise.allSettled([...this.pending]); this.close(); }
}

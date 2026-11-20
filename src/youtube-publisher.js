import { AppError } from './errors.js';
import { normalizeText, normalizeYouTubeChannel } from './content.js';
import { isYouTubeCreateResponse, parseYouTubeCreateResponse, youtubePostFields } from './youtube-evidence.js';

export class YouTubePublisher {
  constructor(connection, config) { this.connection = connection; this.config = config; }

  async goto(page, url) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs }); }
    catch { throw new AppError('youtube_navigation_failed', 'تعذر تحميل YouTube في الجلسة المخفية.'); }
  }

  async activeChannelPath(page) {
    await page.waitForFunction(() => typeof window.ytcfg?.get('LOGGED_IN') === 'boolean'
      || Boolean(document.querySelector('button#avatar-btn, a[href*="accounts.google.com/ServiceLogin"]')),
    null, { timeout: this.config.timeoutMs });
    const avatar = page.locator('button#avatar-btn');
    if (await page.evaluate(() => window.ytcfg?.get('LOGGED_IN')) === false && !await avatar.count()) return null;
    try { await avatar.waitFor({ state: 'visible', timeout: this.config.timeoutMs }); }
    catch { throw new AppError('youtube_account_unverified', 'لم تكتمل تهيئة قائمة حساب YouTube.'); }
    await avatar.click();
    const link = page.locator('ytd-active-account-header-renderer a[href^="/@"], ytd-active-account-header-renderer a[href^="/channel/"]');
    await link.waitFor({ state: 'visible' });
    const url = new URL(await link.getAttribute('href'), 'https://www.youtube.com');
    if (url.hostname !== 'www.youtube.com' || !/^\/(?:@[^/?#]+|channel\/UC[A-Za-z0-9_-]{22})\/?$/.test(url.pathname)) {
      throw new AppError('youtube_channel_unverified', 'تعذر تحديد القناة النشطة من قائمة الحساب.');
    }
    await page.keyboard.press('Escape');
    return url.pathname.replace(/\/$/, '');
  }

  async channelMetadata(page) {
    try {
      await page.waitForFunction(() => Boolean(window.ytInitialData?.metadata?.channelMetadataRenderer?.externalId),
        null, { timeout: this.config.timeoutMs });
      const metadata = await page.evaluate(() => {
        const data = window.ytInitialData.metadata.channelMetadataRenderer;
        return { channel_id: data.externalId, title: data.title, handle_url: data.vanityChannelUrl };
      });
      normalizeYouTubeChannel(metadata.channel_id);
      return metadata;
    } catch { throw new AppError('youtube_channel_unverified', 'تعذر التحقق من معرّف قناة YouTube.'); }
  }

  async accountStatus() {
    return this.connection.exclusive(() => this.connection.withPage(async page => {
      await this.goto(page, 'https://www.youtube.com/');
      return this.accountOnPage(page);
    }));
  }

  async accountOnPage(page) {
    const path = await this.activeChannelPath(page);
    if (!path) return { logged_in: false, channel_id: null };
    await this.goto(page, `https://www.youtube.com${path}/posts`);
    return { logged_in: true, ...await this.channelMetadata(page), session_mode: 'headless-isolated' };
  }

  async requireChannel(page, expected) {
    const channel = await this.channelMetadata(page);
    if (channel.channel_id !== expected) throw new AppError('youtube_channel_mismatch', 'صفحة القناة لا تطابق قناة المسودة.');
    const active = await this.activeChannelPath(page);
    if (!active) throw new AppError('youtube_login_required', 'جهّز تسجيل دخول YouTube في الجلسة المخفية أولًا.');
    let handlePath = null;
    try { handlePath = new URL(channel.handle_url).pathname.replace(/\/$/, '').toLowerCase(); } catch { /* An ID path can still verify the channel. */ }
    if (active !== `/channel/${expected}` && active.toLowerCase() !== handlePath) {
      throw new AppError('youtube_channel_mismatch', 'القناة النشطة لا تطابق قناة المسودة. لم يُنشر شيء.', { expected_channel: expected });
    }
    return channel;
  }

  async composerOnPage(page) {
    const editors = page.locator('ytd-backstage-post-dialog-renderer #creation-box #contenteditable-root[contenteditable="true"]:visible');
    if (!await editors.count()) {
      const placeholder = page.locator('ytd-backstage-post-dialog-renderer #simplebox-placeholder:visible');
      const area = page.locator('ytd-backstage-post-dialog-renderer #placeholder-area:visible');
      if (await placeholder.count() === 1) await placeholder.click();
      else if (await area.count() === 1) await area.click();
    }
    try { await editors.first().waitFor({ state: 'visible', timeout: this.config.timeoutMs }); }
    catch { throw new AppError('youtube_posts_unavailable', 'محرر منشورات القناة غير متاح. تحقق من صلاحية القناة لإنشاء منشورات.'); }
    const composer = page.locator('ytd-backstage-post-dialog-renderer:visible').filter({
      has: page.locator('#creation-box #contenteditable-root[contenteditable="true"]:visible'),
    });
    if (await composer.count() !== 1) throw new AppError('composer_ambiguous', 'لم يمكن تحديد محرر منشور YouTube واحد.');
    return composer;
  }

  async verifyPermalink(page, candidate, draft) {
    await this.goto(page, candidate.post_url);
    const deadline = Date.now() + this.config.timeoutMs;
    let reloaded = false;
    const waitForPost = timeout => page.waitForFunction(postId => [...document.querySelectorAll('ytd-backstage-post-renderer')]
      .some(node => node.data?.postId === postId), candidate.post_id, { timeout });
    try {
      try { await waitForPost(Math.min(3000, this.config.timeoutMs / 2)); }
      catch {
        // A newly created post may not be in the first page response. Refresh
        // the existing permalink once; never retry the publishing action.
        reloaded = true;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
        await waitForPost(Math.max(1, deadline - Date.now()));
      }
    } catch { throw new AppError('youtube_permalink_unverified', 'لم يظهر منشور YouTube عبر رابطه. لا تعاود الإرسال.'); }
    const renderers = await page.locator('ytd-backstage-post-renderer').evaluateAll(nodes => nodes.map(node => ({
      postId: node.data?.postId, authorEndpoint: node.data?.authorEndpoint,
      contentText: node.data?.contentText, backstageAttachment: node.data?.backstageAttachment,
    })));
    const fields = youtubePostFields(renderers.find(renderer => renderer.postId === candidate.post_id));
    if (!fields || fields.channel_id !== draft.account || fields.text === null || normalizeText(fields.text) !== draft.text) {
      throw new AppError('published_content_mismatch', 'لم تطابق قناة المنشور أو نصه المسودة المطلوبة.');
    }
    if (fields.image_count !== (draft.image_sha256 ? 1 : 0)) throw new AppError('published_media_mismatch', 'صورة منشور YouTube لا تطابق المرفقات المطلوبة.');
    return { ...candidate, evidence: { ...candidate.evidence, channel_verified: true, text_verified: true,
      image_count: fields.image_count, image_sha256: draft.image_sha256, permalink_verified: true,
      verification_reloaded: reloaded } };
  }

  async publish(draft, { onSubmitting, onAccepted, signal }) {
    const checkCancelled = () => { if (signal?.aborted) throw new AppError('cancelled', 'أُلغيت العملية.'); };
    return this.connection.exclusive(() => this.connection.withPage(async page => {
      checkCancelled();
      await this.goto(page, `https://www.youtube.com/channel/${draft.account}/posts`);
      await this.requireChannel(page, draft.account);
      const composer = await this.composerOnPage(page);
      const editor = composer.locator('#creation-box #contenteditable-root[contenteditable="true"]:visible');
      await editor.fill(draft.text);
      if (normalizeText(await editor.innerText()) !== draft.text) throw new AppError('composer_text_mismatch', 'نص محرر YouTube لا يطابق المسودة.');

      const imageEditor = composer.locator('ytd-backstage-multi-image-select-renderer');
      if (draft.image_sha256) {
        const addImage = composer.getByRole('button', { name: /^(إضافة صورة|Add image|Image)$/ });
        if (await addImage.count() !== 1) throw new AppError('upload_unavailable', 'لم يمكن تحديد زر إضافة صورة واحد.');
        await addImage.click();
        if (await imageEditor.locator('img:visible').count()) throw new AppError('unexpected_attachment', 'توجد صورة سابقة في المحرر. ابدأ بمنشور فارغ.');
        const input = imageEditor.locator('#dropzone input[type="file"]');
        if (await input.count() !== 1) throw new AppError('upload_unavailable', 'لم يمكن تحديد حقل رفع صورة واحد.');
        await input.setInputFiles({ name: draft.image_mime === 'image/png' ? 'image.png' : 'image.jpg',
          mimeType: draft.image_mime, buffer: Buffer.from(draft.image_bytes) });
        await imageEditor.locator('img:visible').first().waitFor({ state: 'visible' });
        const save = imageEditor.getByRole('button', { name: /^(حفظ الصور|Save images)$/ });
        if (await save.count() === 1 && await save.isVisible()) await save.click();
      }

      const button = composer.locator('#submit-button button:visible');
      if (await button.count() !== 1) throw new AppError('publish_button_ambiguous', 'لم يمكن تحديد زر نشر YouTube واحد.');
      await composer.locator('#submit-button button:visible:not([disabled]):not([aria-disabled="true"])')
        .waitFor({ state: 'visible', timeout: this.config.timeoutMs });
      if (normalizeText(await editor.innerText()) !== draft.text) throw new AppError('composer_text_mismatch', 'تغير نص المنشور قبل الإرسال.');
      const images = await imageEditor.locator('img:visible').count();
      // YouTube renders one upload as a large preview AND a thumbnail. We send
      // exactly one file to an empty composer; verify the logical count in the published post data.
      if (draft.image_sha256 ? images < 1 : images !== 0) throw new AppError('upload_unverified', 'لم يمكن التحقق من إرفاق الصورة كما طُلب.');
      await button.focus();
      if (!await button.evaluate(node => node === document.activeElement)) throw new AppError('publish_button_unfocused', 'تعذر التركيز على زر النشر.');
      checkCancelled();
      await onSubmitting();
      checkCancelled();
      const responsePromise = page.waitForResponse(isYouTubeCreateResponse, { timeout: this.config.timeoutMs });
      responsePromise.catch(() => {});
      await button.press('Enter');
      let response;
      try { response = await responsePromise; }
      catch { throw new AppError('youtube_publish_unverified', 'لم تصل استجابة تؤكد نتيجة النشر. لا تعاود إرسال المسودة.'); }
      let payload;
      try { payload = await response.json(); }
      catch { throw new AppError('youtube_publish_unverified', 'تعذر قراءة نتيجة نشر YouTube.'); }
      const candidate = parseYouTubeCreateResponse(payload, draft);
      await onAccepted(candidate);
      return this.verifyPermalink(page, candidate, draft);
    }));
  }
}

import { AppError } from './errors.js';
import { normalizeText } from './content.js';
import { isMatchingCreateResponse, parseCreateTweet, parsePostUrl } from './x-evidence.js';

export class XPublisher {
  constructor(connection, config) { this.connection = connection; this.config = config; }

  async goto(page, url) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs }); }
    catch { throw new AppError('x_navigation_failed', 'تعذر تحميل X في جلسة Brave. تحقق من اتصال الموقع ثم أعد المحاولة.'); }
  }

  async accountOnPage(page) {
    const account = page.getByTestId('SideNav_AccountSwitcher_Button');
    const profile = page.getByTestId('AppTabBar_Profile_Link');
    try {
      await Promise.any([
        page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], a[href="/login"], a[href="/i/flow/login"]')
          .first().waitFor({ state: 'attached', timeout: this.config.timeoutMs }),
        page.waitForURL(url => /^\/i\/flow\/login|^\/login/.test(url.pathname), { timeout: this.config.timeoutMs }),
      ]);
    } catch { throw new AppError('account_unverified', 'لم يمكن التحقق من حساب X في الصفحة الحالية.'); }
    if (await account.count()) {
      const text = `${await account.first().innerText()} ${await account.first().getAttribute('aria-label') ?? ''}`;
      const match = /@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/.exec(text);
      if (match) return { logged_in: true, account: `@${match[1].toLowerCase()}` };
    }
    if (await profile.count()) {
      const href = await profile.first().getAttribute('href');
      const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(href ?? '');
      if (match) return { logged_in: true, account: `@${match[1].toLowerCase()}` };
    }
    if (/^\/i\/flow\/login|^\/login/.test(new URL(page.url()).pathname)
      || await page.locator('a[href="/login"], a[href="/i/flow/login"]').count()) {
      return { logged_in: false, account: null };
    }
    throw new AppError('account_unverified', 'ظهرت جلسة X لكن لم يمكن تحديد هوية الحساب.');
  }

  async requireAccount(page, expected) {
    const status = await this.accountOnPage(page);
    if (!status.logged_in) throw new AppError('x_login_required', 'سجّل الدخول إلى X بنفسك في Brave ثم أعد فحص الحساب.');
    if (status.account !== `@${expected}`) throw new AppError('account_mismatch', 'حساب Brave الحالي لا يطابق حساب المسودة.', {
      expected: `@${expected}`, actual: status.account,
    });
    return status;
  }

  async accountStatus() {
    return this.connection.exclusive(() => this.connection.withPage(async page => {
      await this.goto(page, 'https://x.com/home');
      return this.accountOnPage(page);
    }));
  }

  async composerOnPage(page) {
    await page.locator('[data-testid="tweetTextarea_0"][contenteditable="true"]').first().waitFor({ state: 'visible' });
    const activeModal = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator('[data-testid="tweetTextarea_0"]') });
    if (await activeModal.count() === 1) return activeModal;
    const dialogs = page.getByRole('dialog').filter({ has: page.locator('[data-testid="tweetTextarea_0"]') });
    // X also renders a home-feed editor underneath its active compose dialog.
    const count = await dialogs.count();
    if (count > 1) throw new AppError('composer_ambiguous', 'لم يمكن تحديد نافذة إنشاء المنشور النشطة.');
    return count === 1 ? dialogs : page;
  }

  async verifyPermalink(page, candidate, draft) {
    await this.goto(page, candidate.post_url);
    await this.requireAccount(page, draft.account);
    const article = page.locator('article[data-testid="tweet"]').filter({
      has: page.locator(`a[href$="/status/${candidate.post_id}"]`),
    }).first();
    await article.waitFor({ state: 'visible', timeout: this.config.timeoutMs });
    const author = article.locator('[data-testid="User-Name"] a').first();
    const authorHref = await author.getAttribute('href');
    if (authorHref?.toLowerCase() !== `/${draft.account}`) {
      throw new AppError('post_account_mismatch', 'لم يمكن التحقق من صاحب المنشور من رابطه.');
    }
    // The response already verifies expanded URLs. A rendered permalink confirms that it exists.
    if (!candidate.evidence.text_verified) {
      const text = await article.getByTestId('tweetText').first().evaluate(element => {
        const copy = element.cloneNode(true);
        for (const anchor of copy.querySelectorAll('a')) {
          if (anchor.title && /^https?:\/\//.test(anchor.title)) anchor.textContent = anchor.title;
        }
        return copy.textContent;
      });
      if (normalizeText(text ?? '') !== draft.text) {
        throw new AppError('published_content_mismatch', 'لم يمكن مطابقة نص المنشور الظاهر مع المسودة.');
      }
      const photos = await article.getByTestId('tweetPhoto').count();
      if (photos !== (draft.image_sha256 ? 1 : 0)) throw new AppError('published_media_mismatch', 'مرفقات المنشور الظاهر لا تطابق المسودة.');
      candidate.evidence.text_verified = true;
      candidate.evidence.image_count = photos;
    }
    return { ...candidate, evidence: { ...candidate.evidence, account_verified: true, permalink_verified: true } };
  }

  async publish(draft, { onSubmitting, onAccepted, signal }) {
    const checkCancelled = () => {
      if (signal?.aborted) throw new AppError('cancelled', 'أُلغيت العملية.');
    };
    return this.connection.exclusive(() => this.connection.withPage(async page => {
      checkCancelled();
      await this.goto(page, 'https://x.com/compose/post');
      await this.requireAccount(page, draft.account);
      const composer = await this.composerOnPage(page);
      const editor = composer.locator('[data-testid="tweetTextarea_0"][contenteditable="true"]:visible');
      await editor.waitFor({ state: 'visible', timeout: this.config.timeoutMs });
      if (await editor.count() !== 1) throw new AppError('composer_ambiguous', 'لم يمكن تحديد محرر منشور واحد.');
      await editor.fill(draft.text);
      if (normalizeText(await editor.innerText()) !== draft.text) throw new AppError('composer_text_mismatch', 'النص داخل المحرر لا يطابق المسودة.');

      if (draft.image_sha256) {
        const upload = composer.locator('input[data-testid="fileInput"][type="file"]');
        if (await upload.count() !== 1) throw new AppError('upload_unavailable', 'لم يوجد عنصر رفع صورة واحد. لم يُرسل المنشور.');
        await upload.setInputFiles({ name: draft.image_mime === 'image/png' ? 'image.png' : 'image.jpg',
          mimeType: draft.image_mime, buffer: Buffer.from(draft.image_bytes) });
        await composer.locator('[data-testid="attachments"] img').first().waitFor({ state: 'visible' });
        await composer.locator('[data-testid="attachments"] [role="progressbar"]').waitFor({ state: 'hidden' });
      }

      const button = composer.locator('[data-testid="tweetButton"]:visible, [data-testid="tweetButtonInline"]:visible');
      if (await button.count() !== 1) throw new AppError('publish_button_ambiguous', 'لم يمكن تحديد زر نشر واحد.');
      await button.waitFor({ state: 'visible' });
      await composer.locator('[data-testid="tweetButton"]:visible:not([disabled]):not([aria-disabled="true"]), [data-testid="tweetButtonInline"]:visible:not([disabled]):not([aria-disabled="true"])')
        .waitFor({ state: 'visible', timeout: this.config.timeoutMs });
      await this.requireAccount(page, draft.account);
      if (normalizeText(await editor.innerText()) !== draft.text) throw new AppError('composer_text_mismatch', 'تغير النص قبل النشر.');
      const previews = await composer.locator('[data-testid="attachments"] img').count();
      if (draft.image_sha256 && previews !== 1) throw new AppError('upload_unverified', 'لم يمكن التحقق من إرفاق الصورة المطلوبة.');
      if (!draft.image_sha256 && previews !== 0) throw new AppError('unexpected_attachment', 'ظهرت مرفقات غير مطلوبة في المحرر.');

      // X can paint a transparent pointer-intercepting layer over the enabled
      // button. Keyboard activation follows its normal accessible button action.
      await button.focus();
      if (!await button.evaluate(element => element === document.activeElement)) {
        throw new AppError('publish_button_unfocused', 'تعذر التركيز على زر النشر. لم يُرسل المنشور.');
      }

      // Persist the uncertainty boundary BEFORE the first action that can publish.
      checkCancelled();
      await onSubmitting();
      checkCancelled();
      const responsePromise = page.waitForResponse(response => isMatchingCreateResponse(response, draft), { timeout: this.config.timeoutMs });
      responsePromise.catch(() => {});
      try { await button.press('Enter'); }
      catch (error) {
        throw new AppError('publish_activation_failed', 'تعذر إكمال تفعيل زر النشر؛ يلزم التحقق من النتيجة قبل أي محاولة أخرى.', { reason: error.message.split('\n')[0] });
      }
      let candidate;
      let response;
      try { response = await responsePromise; } catch { /* Try an explicit success permalink, never the latest timeline item. */ }
      if (response) {
        let payload;
        try { payload = await response.json(); }
        catch { throw new AppError('publish_unverified', 'تعذر قراءة استجابة النشر. تحقق من الحساب قبل أي محاولة أخرى.'); }
        candidate = parseCreateTweet(payload, draft);
      } else {
        const link = page.locator('[data-testid="toast"] a[href*="/status/"]').first();
        if (!await link.count()) throw new AppError('publish_unverified', 'لم يتوفر دليل على نتيجة الإرسال. لا تعاود إرسال المسودة.');
        candidate = { ...parsePostUrl(await link.getAttribute('href'), draft.account),
          evidence: { source: 'success_toast_permalink', text_verified: false,
            account_verified: false, image_sha256: draft.image_sha256, permalink_verified: false } };
      }
      await onAccepted(candidate);
      return this.verifyPermalink(page, candidate, draft);
    }));
  }
}

import { chromium } from 'playwright-core';
import { AppError } from './errors.js';

export class BraveConnection {
  constructor(config) { this.config = config; this.queue = Promise.resolve(); }

  exclusive(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async withContext(fn) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(this.config.cdpEndpoint, { timeout: Math.min(this.config.timeoutMs, 10000) });
    } catch (error) {
      throw new AppError('brave_not_connected', 'تعذر الاتصال بـBrave. افتح المتصفح مع تفعيل اتصال CDP المحلي.', {
        endpoint: this.config.cdpEndpoint, setup: 'docs/brave-setup.md', reason: error.message.split('\n')[0],
      });
    }
    try {
      const context = browser.contexts()[0];
      if (!context) throw new AppError('browser_context_missing', 'لم تُوجد جلسة Brave مفتوحة يمكن استخدامها.');
      return await fn(context, browser);
    } finally {
      // For connectOverCDP this detaches our client; never close the user's context.
      await browser.close().catch(() => {});
    }
  }

  async withPage(fn) {
    return this.withContext(async context => {
      const page = await context.newPage();
      page.setDefaultTimeout(this.config.timeoutMs);
      try { return await fn(page, context); }
      finally { await page.close({ runBeforeUnload: false }).catch(() => {}); }
    });
  }

  async status() {
    return this.exclusive(() => this.withContext(async (_context, browser) => ({
      connected: true, browser_version: browser.version(), endpoint: this.config.cdpEndpoint,
      session_mode: 'existing-brave-session',
    })));
  }
}

// Runtime publishing uses an OWNED headless browser with a separate profile.
// The CDP connection above is only needed for the one-time X session import.
export class HeadlessBraveConnection extends BraveConnection {
  async withContext(fn) {
    let context;
    try {
      context = await chromium.launchPersistentContext(this.config.profileDir, {
        executablePath: this.config.bravePath, headless: true,
        timeout: this.config.timeoutMs, viewport: { width: 1280, height: 900 },
      });
    } catch (error) {
      throw new AppError('headless_brave_unavailable', 'تعذر تشغيل Brave المخفي. تحقق من مسار المتصفح وأن ملف الأداة غير مستخدم في عملية أخرى.', {
        reason: error.message.slice(0, 2500),
      });
    }
    try { return await fn(context, context.browser()); }
    finally { await context.close(); }
  }

  async status() {
    return this.exclusive(() => this.withContext(async (_context, browser) => ({
      connected: true, browser_version: browser.version(), session_mode: 'headless-isolated',
    })));
  }
}

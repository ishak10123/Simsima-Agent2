import { relative, isAbsolute } from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { BraveConnection, HeadlessBraveConnection } from '../src/browser.js';
import { XPublisher } from '../src/x-publisher.js';
import { YouTubePublisher } from '../src/youtube-publisher.js';
import { AppError, errorResult } from '../src/errors.js';

// Transfer only the selected platform's cookies in memory from the authorized local
// browser into a separate Brave-owned profile. Never write a cookie JSON file.
const config = loadConfig();
const youtube = process.argv.includes('--youtube');
const origin = youtube ? 'https://www.youtube.com' : 'https://x.com';
const domains = youtube ? ['youtube.com', '.youtube.com', 'www.youtube.com'] : ['x.com', '.x.com'];
const withinRepository = relative(projectRoot, config.profileDir);
try {
  if (!withinRepository || (!withinRepository.startsWith('..') && !isAbsolute(withinRepository))) {
    throw new AppError('invalid_config', 'احفظ جلسة الحساب خارج مجلد المشروع.');
  }
  const source = new BraveConnection(config);
  const destination = new HeadlessBraveConnection(config);
  const hiddenPublisher = youtube ? new YouTubePublisher(destination, config) : new XPublisher(destination, config);
  const result = await source.withContext(async sourceContext => {
    // Read the session without opening or navigating any visible browser tab.
    const cookies = (await sourceContext.cookies(origin)).filter(cookie => domains.includes(cookie.domain));
    if (!cookies.some(cookie => youtube ? /^(?:__Secure-[13]P)?(?:SID|SAPISID)$/.test(cookie.name) : cookie.name === 'auth_token')) {
      throw new AppError('login_required', 'جلسة المنصة المصدر غير مكتملة.');
    }
    return destination.withContext(async context => {
      await context.clearCookies({ domain: youtube ? /(^|\.)youtube\.com$/ : /(^|\.)x\.com$/ });
      await context.addCookies(cookies);
      const page = await context.newPage();
      await hiddenPublisher.goto(page, youtube ? origin : `${origin}/home`);
      const account = await hiddenPublisher.accountOnPage(page);
      if (!account.logged_in) throw new AppError('login_required', 'لم يمكن تفعيل الجلسة داخل المتصفح المخفي.');
      return { session_imported: true, platform: youtube ? 'youtube' : 'x', ...account, session_mode: 'headless-isolated' };
    });
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: errorResult(error) }, null, 2)); process.exitCode = 1; }

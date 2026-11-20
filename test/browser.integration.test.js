import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { BraveConnection, HeadlessBraveConnection } from '../src/browser.js';
import { AgentService } from '../src/service.js';

const bravePath = loadConfig().bravePath;
let installed = true;
try { await access(bravePath); } catch { installed = false; }
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

test('Isolated headless Brave publishes without touching the source browser', { skip: !installed, timeout: 90000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'simsima-browser-'));
  const profileDir = join(dir, 'profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: bravePath, headless: true, args: ['--remote-debugging-port=0'],
  });
  let service;
  t.after(async () => { await service?.shutdown(); await context.close(); await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); });
  const [port] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n');
  const config = { ...loadConfig(), cdpEndpoint: `http://127.0.0.1:${port.trim()}`, profileDir: join(dir, 'automation'), dataDir: join(dir, 'data'), timeoutMs: 5000 };
  const connection = new BraveConnection(config);
  const hidden = new HeadlessBraveConnection(config);
  service = new AgentService(config, { connection: hidden });
  let scenario = { account: 'alice', text: '', photo: false, fail: false, uploadBroken: false };
  let submissions = 0;

  const fixtureRoute = async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'x.com') return route.abort();
    if (url.pathname.endsWith('/CreateTweet')) {
      submissions++;
      const input = route.request().postDataJSON();
      scenario.text = input.variables.tweet_text;
      scenario.photo = input.variables.hasImage;
      const media = scenario.photo ? [{ type: 'photo', url: 'https://t.co/media' }] : [];
      return route.fulfill({ json: scenario.fail ? { errors: [{ message: 'simulated response failure' }] } : {
        data: { create_tweet: { tweet_results: { result: { rest_id: '1234567890',
          core: { user_results: { result: { core: { screen_name: scenario.account } } } },
          legacy: { full_text: scenario.text + (scenario.photo ? ' https://t.co/media' : ''),
            extended_entities: { media }, entities: { urls: [] } },
        } } } },
      } });
    }
    const post = url.pathname.includes('/status/') ? `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/${scenario.account}">Alice</a></div>
      <a href="/${scenario.account}/status/1234567890">Date</a><time>now</time>
      <div data-testid="tweetText">${escape(scenario.text)}</div>${scenario.photo ? '<div data-testid="tweetPhoto">photo</div>' : ''}
    </article>` : '';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
      <button data-testid="SideNav_AccountSwitcher_Button">Alice @${scenario.account}</button>
      <a data-testid="AppTabBar_Profile_Link" href="/${scenario.account}">Profile</a>
      ${post || `<div data-testid="tweetTextarea_0" contenteditable="true">background editor</div>
        <input data-testid="fileInput" type="file"><button data-testid="tweetButtonInline">Background post</button>
        <div role="dialog"><section role="dialog" aria-modal="true"><div data-testid="tweetTextarea_0" contenteditable="true" style="border:1px solid;min-height:40px"> </div>
        <input data-testid="fileInput" type="file"><div data-testid="attachments"></div>
        <div style="position:relative;width:80px"><button data-testid="tweetButton">Post</button><div style="position:absolute;inset:0;z-index:1"></div></div></section></div><div data-testid="toast"></div>
        <script>
          const composer = document.querySelector('[aria-modal="true"]');
          const input = composer.querySelector('input');
          input.onchange = () => {
            if (${scenario.uploadBroken}) return;
            const image = document.createElement('img'); image.width = 40; image.height = 40;
            image.src = URL.createObjectURL(input.files[0]); composer.querySelector('[data-testid="attachments"]').append(image);
          };
          document.querySelector('[data-testid="tweetButton"]').onclick = async () => {
            await fetch('/i/api/graphql/fixture/CreateTweet', { method:'POST', headers:{'Content-Type':'application/json'},
              body:JSON.stringify({variables:{tweet_text:composer.querySelector('[contenteditable]').innerText,hasImage:input.files.length > 0}}) });
            document.querySelector('[data-testid="toast"]').innerHTML = '<a href="/${scenario.account}/status/1234567890">View</a>';
          };
        </script>`}` });
  };
  const hiddenWithContext = hidden.withContext.bind(hidden);
  hidden.withContext = fn => hiddenWithContext(async (ownedContext, browser) => {
    await ownedContext.route('**/*', fixtureRoute);
    return fn(ownedContext, browser);
  });

  await t.test('disconnecting the tool leaves the existing Brave tab open', async () => {
    const sentinel = context.pages()[0];
    const count = context.pages().length;
    assert.equal((await connection.status()).connected, true);
    assert.equal(sentinel.isClosed(), false);
    assert.equal(context.pages().length, count);
  });
  await t.test('headless mode uses its own persistent session and leaves source tabs unchanged', async () => {
    await hidden.withContext(owned => owned.addCookies([{ name: 'fixture_session', value: 'saved', url: 'https://x.com', expires: Math.floor(Date.now() / 1000) + 86400 }]));
    await hidden.withContext(async (owned, browser) => {
      assert.equal((await owned.cookies('https://x.com')).find(cookie => cookie.name === 'fixture_session')?.value, 'saved');
      const cdp = await browser.newBrowserCDPSession();
      const version = await cdp.send('Browser.getVersion');
      assert.match(version.userAgent, /HeadlessChrome/);
    });
    assert.equal(context.pages().length, 1);
    assert.equal(context.pages()[0].isClosed(), false);
  });
  await t.test('account read and a verified text post through the hidden session', async () => {
    assert.equal((await service.accountStatus()).account, '@alice');
    const draft = await service.preparePost({ text: 'مرحبا من الاختبار', account: '@alice' });
    const result = await service.publishPost({ draft_id: draft.draft_id, request_id: 'browser-text-001' });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.evidence.permalink_verified, true);
    assert.equal(submissions, 1);
  });
  await t.test('a PNG is actually attached before sending', async () => {
    const path = join(dir, 'image.png');
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const draft = await service.preparePost({ text: 'صورة تجريبية', account: 'alice', image_path: path });
    const result = await service.publishPost({ draft_id: draft.draft_id, request_id: 'browser-image-001' });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.evidence.image_count, 1);
    assert.equal(submissions, 2);
  });
  await t.test('wrong account fails before any publish request', async () => {
    const draft = await service.preparePost({ text: 'do not send', account: 'bob' });
    const result = await service.publishPost({ draft_id: draft.draft_id, request_id: 'browser-wrong-001' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'account_mismatch');
    assert.equal(submissions, 2);
  });
  await t.test('an unverified response is uncertain and cannot resend', async () => {
    scenario.fail = true;
    const draft = await service.preparePost({ text: 'uncertain', account: 'alice' });
    const input = { draft_id: draft.draft_id, request_id: 'browser-uncertain-001' };
    assert.equal((await service.publishPost(input)).status, 'uncertain');
    assert.equal((await service.publishPost(input)).replayed, true);
    assert.equal(submissions, 3);
  });
});

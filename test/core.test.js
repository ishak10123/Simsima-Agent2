import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { AgentService } from '../src/service.js';
import { normalizeAccount, validateText, readImage } from '../src/content.js';
import { validateEndpoint } from '../src/config.js';
import { parseCreateTweet } from '../src/x-evidence.js';

const makeDir = () => mkdtemp(join(tmpdir(), 'simsima-test-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('validates Arabic, weighted links and explicit loopback endpoints', () => {
  assert.equal(validateText('مرحبا بالعالم').text, 'مرحبا بالعالم');
  assert.equal(normalizeAccount('@Alice'), 'alice');
  assert.equal(validateText(`hello https://example.com/${'a'.repeat(300)}`).weightedLength, 29);
  assert.throws(() => validateText('a'.repeat(281)), { code: 'invalid_text' });
  assert.throws(() => validateText(' '), { code: 'invalid_text' });
  assert.equal(validateEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.throws(() => validateEndpoint('http://example.com:9222'), { code: 'invalid_config' });
});

test('snapshots the image and fails on unreadable or unsupported files', async t => {
  const dir = await makeDir(t);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'photo.png');
  await writeFile(path, png);
  const image = await readImage(path);
  await writeFile(path, 'changed');
  assert.deepEqual(image.bytes, png);
  assert.equal(image.mimeType, 'image/png');
  await assert.rejects(readImage(path), { code: 'invalid_image' });
  await assert.rejects(readImage(join(dir, 'missing.png')), { code: 'image_unreadable' });
});

test('one request publishes once; a second ID cannot resend the same draft', async t => {
  const dir = await makeDir(t);
  let sends = 0;
  const service = new AgentService({ dataDir: dir }, { publisher: { async publish(_draft, hooks) {
    sends++;
    await hooks.onSubmitting();
    return { post_id: '123', post_url: 'https://x.com/alice/status/123', evidence: { permalink_verified: true } };
  } } });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const draft = await service.preparePost({ text: 'مرحبا', account: '@alice' });
  const input = { draft_id: draft.draft_id, request_id: 'request-0001' };
  assert.equal((await service.publishPost(input)).status, 'succeeded');
  assert.equal((await service.publishPost(input)).replayed, true);
  await assert.rejects(service.publishPost({ ...input, request_id: 'request-0002' }), { code: 'draft_already_submitted' });
  assert.equal(sends, 1);
});

test('failure before submit permits a new attempt; failure after submit stays uncertain across restarts', async t => {
  const dir = await makeDir(t);
  let stage = 'before';
  const publisher = { async publish(_draft, hooks) {
    if (stage === 'after') await hooks.onSubmitting();
    throw new Error('simulated interruption');
  } };
  const service = new AgentService({ dataDir: dir }, { publisher });
  const draft = await service.preparePost({ text: 'hello', account: 'alice' });
  const input = { draft_id: draft.draft_id, request_id: 'request-0001' };
  assert.equal((await service.publishPost(input)).status, 'failed');
  stage = 'after';
  assert.equal((await service.publishPost({ ...input, request_id: 'request-0002' })).status, 'uncertain');
  service.close();
  const reopened = new Store(dir);
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(reopened.getOperation('request-0002').status, 'uncertain');
  assert.throws(() => reopened.claim('request-0003', draft.draft_id), { code: 'draft_already_submitted' });
});

test('two database connections serialize publishing and recover a dead submitter conservatively', async t => {
  const dir = await makeDir(t);
  const first = new Store(dir);
  const second = new Store(dir);
  t.after(async () => { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); });
  const one = first.createDraft({ text: 'one', account: 'alice', weightedLength: 3 });
  const two = first.createDraft({ text: 'two', account: 'alice', weightedLength: 3 });
  first.claim('request-0001', one.draft_id);
  assert.throws(() => second.claim('request-0002', two.draft_id), { code: 'browser_busy' });
  assert.equal(second.claim('request-0001', one.draft_id).acquired, false);
  first.markSubmitting('request-0001');
  second.isProcessAlive = () => false;
  second.recover();
  assert.equal(second.getOperation('request-0001').status, 'uncertain');
  assert.equal(second.claim('request-0002', two.draft_id).acquired, true);
});

test('a response must match text, author and attachment count', () => {
  const draft = { account: 'alice', text: 'hello https://example.com', image_sha256: null };
  const payload = { data: { create_tweet: { tweet_results: { result: {
    rest_id: '123', core: { user_results: { result: { core: { screen_name: 'Alice' } } } },
    legacy: { full_text: 'hello https://t.co/abc', entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com' }] } },
  } } } } };
  assert.equal(parseCreateTweet(payload, draft).post_url, 'https://x.com/alice/status/123');
  assert.throws(() => parseCreateTweet(payload, { ...draft, account: 'bob' }), { code: 'published_content_mismatch' });
  assert.throws(() => parseCreateTweet(payload, { ...draft, image_sha256: 'abc' }), { code: 'published_media_mismatch' });
});

test('a known accepted post can be confirmed after a permalink verification timeout without resending', async t => {
  const dir=await makeDir();
  const store=new Store(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const draft=store.createDraft({text:'hello',account:'alice',weightedLength:5});
  store.claim('recovery-0001',draft.draft_id);
  store.markSubmitting('recovery-0001');
  const candidate={post_id:'123',post_url:'https://x.com/alice/status/123',evidence:{permalink_verified:false}};
  store.recordCandidate('recovery-0001',candidate);
  assert.equal(store.finish('recovery-0001',{error:{code:'timeout'}}).status,'uncertain');
  assert.equal(store.finish('recovery-0001',{result:{...candidate,post_id:'456',evidence:{permalink_verified:true}}}).status,'uncertain');
  assert.equal(store.finish('recovery-0001',{result:candidate}).status,'uncertain');
  assert.equal(store.finish('recovery-0001',{result:{...candidate,evidence:{permalink_verified:true}}}).status,'succeeded');
  assert.equal(store.getOperation('recovery-0001').post_id,'123');
});

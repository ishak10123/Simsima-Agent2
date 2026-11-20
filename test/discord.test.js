import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../src/service.js';
import { DiscordPublisher, parseWebhookUrl } from '../src/discord-publisher.js';
import { validateDiscordText, normalizeDiscordChannel } from '../src/content.js';

const channel = '123456789012345678';
const guild = '234567890123456789';
const webhookId = '345678901234567890';
const messageId = '456789012345678901';
const token = 'secret-for-local-tests-only-0123456789';
const webhookUrl = `https://discord.com/api/webhooks/${webhookId}/${token}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function setup(t, { configured = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'simsima-discord-'));
  const config = { dataDir: dir, discordConfigPath: join(dir, 'discord.json'), timeoutMs: 1000 };
  if (configured) await writeFile(config.discordConfigPath, JSON.stringify({ webhook_url: webhookUrl }));
  const calls = [];
  const state = { channel, failPost: null, failRead: false, content: null };
  let savedMessage;
  const publisher = new DiscordPublisher(config, { fetch: async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      if (state.failPost instanceof Error) throw state.failPost;
      if (state.failPost) return json({ retry_after: 1.5 }, state.failPost);
      const payload = typeof options.body === 'string' ? JSON.parse(options.body) : JSON.parse(options.body.get('payload_json'));
      assert.deepEqual(payload.allowed_mentions, { parse: [] });
      const file = typeof options.body === 'string' ? null : options.body.get('files[0]');
      savedMessage = { id: messageId, webhook_id: webhookId, channel_id: state.channel,
        content: state.content ?? payload.content,
        attachments: file ? [{ id: '567890123456789012', filename: file.name, content_type: file.type, size: file.size }] : [] };
      return json(savedMessage);
    }
    if (url.includes('/messages/')) {
      if (state.failRead) throw new Error(`network failure includes ${url}`);
      return json(savedMessage);
    }
    return json({ id: webhookId, type: 1, guild_id: guild, channel_id: state.channel, token, name: 'Simsima' });
  } });
  const connection = { withPage() { throw new Error('Discord must not launch a browser'); } };
  const service = new AgentService(config, { discordPublisher: publisher, connection });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, calls, state, service, publisher };
}

test('Discord validates text, channel and webhook host without exposing the token', () => {
  assert.equal(validateDiscordText('  مرحبا\r\nالعالم ').text, 'مرحبا\nالعالم');
  assert.equal(validateDiscordText('ع'.repeat(2000)).weightedLength, 2000);
  assert.throws(() => validateDiscordText('ع'.repeat(2001)), { code: 'invalid_text' });
  assert.throws(() => normalizeDiscordChannel('@alice'), { code: 'invalid_channel' });
  assert.equal(parseWebhookUrl(webhookUrl).url, webhookUrl.replace('/api/', '/api/v10/'));
  for (const value of [webhookUrl.replace('discord.com', 'example.com'), webhookUrl.replace('https:', 'http:'),
    `${webhookUrl}?thread_id=${channel}`, `${webhookUrl}#fragment`, webhookUrl.replace('discord.com', 'discord.com:8443')]) {
    assert.throws(() => parseWebhookUrl(value), error => error.code === 'invalid_discord_webhook' && !JSON.stringify(error).includes(token));
  }
});

test('Discord config can be filled after startup and status never returns the token', async t => {
  const { service, config, calls } = await setup(t, { configured: false });
  assert.equal((await service.discordStatus()).configured, false);
  assert.equal(calls.length, 0);
  await writeFile(config.discordConfigPath, JSON.stringify({ webhook_url: webhookUrl }));
  const status = await service.discordStatus();
  assert.equal(status.configured, true);
  assert.equal(status.channel_id, channel);
  assert.equal(status.channel_url, `https://discord.com/channels/${guild}/${channel}`);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test('Discord sends text once, verifies via GET and replays the saved result', async t => {
  const { service, calls } = await setup(t);
  const draft = await service.prepareDiscordPost({ text: 'اختبار @everyone', channel_id: channel });
  const input = { draft_id: draft.draft_id, request_id: 'discord-text-001' };
  await assert.rejects(service.publishPost(input), { code: 'platform_mismatch' });
  const result = await service.publishDiscordPost(input);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.post_url, `https://discord.com/channels/${guild}/${channel}/${messageId}`);
  assert.equal(result.evidence.permalink_verified, true);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(calls.find(call => call.method === 'POST').url, /\?wait=true$/);
  assert.equal(calls.at(-1).url.endsWith(`/messages/${messageId}`), true);
  assert.equal((await service.publishDiscordPost(input)).replayed, true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('Discord uploads one immutable image snapshot with the caption', async t => {
  const { dir, service, calls } = await setup(t);
  const path = join(dir, 'original.png');
  await writeFile(path, png);
  const draft = await service.prepareDiscordPost({ text: 'صورة', channel_id: channel, image_path: path });
  await unlink(path);
  const result = await service.publishDiscordPost({ draft_id: draft.draft_id, request_id: 'discord-image-001' });
  assert.equal(result.status, 'succeeded');
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual([...post.body.keys()], ['payload_json', 'files[0]']);
  assert.deepEqual(Buffer.from(await post.body.get('files[0]').arrayBuffer()), png);
  assert.deepEqual(JSON.parse(post.body.get('payload_json')).attachments, [{ id: 0, filename: 'image.png' }]);
  assert.equal(result.evidence.image_sha256, draft.image.sha256);
});

test('a changed Discord channel stops before any message is sent', async t => {
  const { service, state, calls } = await setup(t);
  const draft = await service.prepareDiscordPost({ text: 'wrong destination', channel_id: channel });
  state.channel = '678901234567890123';
  const result = await service.publishDiscordPost({ draft_id: draft.draft_id, request_id: 'discord-channel-001' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'discord_channel_mismatch');
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('a known Discord message can be verified after a read failure, without resending', async t => {
  const { service, state, calls } = await setup(t);
  const draft = await service.prepareDiscordPost({ text: 'تأكيد لاحق', channel_id: channel });
  const input = { draft_id: draft.draft_id, request_id: 'discord-recover-001' };
  state.failRead = true;
  const uncertain = await service.publishDiscordPost(input);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.post_id, messageId);
  assert.equal(JSON.stringify(uncertain).includes(token), false);
  await assert.rejects(service.verifyOperation(input), { code: 'discord_request_unverified' });
  assert.equal(service.getOperation(input).status, 'uncertain');
  state.failRead = false;
  assert.equal((await service.verifyOperation(input)).status, 'succeeded');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('ambiguous Discord failures remain uncertain and cannot be sent again', async t => {
  const { service, state, calls } = await setup(t);
  for (const [index, failure] of [new Error(`network failure ${webhookUrl}`), 500].entries()) {
    state.failPost = failure;
    const draft = await service.prepareDiscordPost({ text: `test ${index}`, channel_id: channel });
    const input = { draft_id: draft.draft_id, request_id: `discord-uncertain-${index}` };
    const result = await service.publishDiscordPost(input);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.post_id, null);
    assert.equal(JSON.stringify(result).includes(token), false);
    const before = calls.length;
    assert.equal((await service.publishDiscordPost(input)).replayed, true);
    assert.equal((await service.verifyOperation(input)).status, 'uncertain');
    assert.equal(calls.length, before);
    await assert.rejects(service.publishDiscordPost({ ...input, request_id: `${input.request_id}-retry` }), { code: 'draft_already_submitted' });
  }
});

test('definite Discord rejections are failed and rate limits do not trigger automatic retries', async t => {
  const { service, state, calls } = await setup(t);
  for (const status of [400, 401, 403, 404, 413, 429]) {
    state.failPost = status;
    const draft = await service.prepareDiscordPost({ text: 'rejected', channel_id: channel });
    const result = await service.publishDiscordPost({ draft_id: draft.draft_id, request_id: `discord-reject-${status}` });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.details.http_status, status);
    if (status === 429) assert.equal(result.error.details.retry_after_seconds, 1.5);
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, 6);
});

test('mismatched Discord content retains its known message and blocks a resend', async t => {
  const { service, state } = await setup(t);
  state.content = 'unexpected';
  const draft = await service.prepareDiscordPost({ text: 'expected', channel_id: channel });
  const input = { draft_id: draft.draft_id, request_id: 'discord-mismatch-001' };
  const result = await service.publishDiscordPost(input);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.post_id, messageId);
  assert.equal(result.error.code, 'discord_content_mismatch');
  await assert.rejects(service.verifyOperation(input), { code: 'discord_content_mismatch' });
});

test('read-only recovery for X and YouTube verifies the recorded candidate without publishing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'simsima-verify-'));
  let reads = 0;
  const publisher = { async publish() { throw new Error('must not send'); }, async verifyPermalink(_page, candidate) {
    reads++;
    return { ...candidate, evidence: { ...candidate.evidence, permalink_verified: true } };
  } };
  const connection = { exclusive: fn => fn(), withPage: fn => fn({}) };
  const service = new AgentService({ dataDir: dir }, { connection, publisher, youtubePublisher: publisher });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  for (const platform of ['x', 'youtube']) {
    const draft = platform === 'x' ? await service.preparePost({ text: 'existing', account: 'alice' })
      : await service.prepareYouTubePost({ text: 'existing', channel_id: 'UCabcdefghijklmnopqrstuv' });
    const request_id = `verify-${platform}-001`;
    service.store.claim(request_id, draft.draft_id);
    service.store.markSubmitting(request_id);
    service.store.recordCandidate(request_id, { post_id: '123', post_url: 'https://example.test/123', evidence: {} });
    service.store.finish(request_id, { error: { code: 'timeout' } });
    assert.equal((await service.verifyOperation({ request_id })).status, 'succeeded');
    await service.verifyOperation({ request_id });
  }
  assert.equal(reads, 2);
});

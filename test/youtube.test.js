import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { AgentService } from '../src/service.js';
import { normalizeYouTubeChannel, validateYouTubeText } from '../src/content.js';
import { parseYouTubeCreateResponse, parseYouTubePostUrl, youtubePostFields } from '../src/youtube-evidence.js';

const channel='UCabcdefghijklmnopqrstuv';
const post='Ugkxabcdefghijklmnopqrstuv';

test('YouTube drafts accept channel IDs and text independently from X limits',()=>{
  assert.equal(normalizeYouTubeChannel(channel),channel);
  assert.equal(validateYouTubeText('ع'.repeat(500)).weightedLength,500);
  assert.throws(()=>validateYouTubeText('ع'.repeat(1001)),{code:'invalid_text'});
  assert.throws(()=>normalizeYouTubeChannel('@alice'),{code:'invalid_channel'});
});

test('existing X drafts survive the additive platform migration',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'simsima-migration-'));
  const legacy=new DatabaseSync(join(dir,'simsima.sqlite'));
  legacy.exec(`CREATE TABLE drafts(id TEXT PRIMARY KEY,text TEXT NOT NULL,account TEXT NOT NULL,weighted_length INTEGER NOT NULL,image_name TEXT,image_mime TEXT,image_sha256 TEXT,image_bytes BLOB,created_at TEXT NOT NULL)`);
  legacy.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?)').run('old-x-draft','unchanged','alice',9,null,null,null,null,'2026-01-01T00:00:00Z');
  legacy.close();
  const store=new Store(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  assert.equal(store.getDraft('old-x-draft').platform,'x');
  assert.equal(store.publicDraft(store.getDraft('old-x-draft')).account,'@alice');
  assert.equal(store.getDraft('old-x-draft').text,'unchanged');
  const draft=store.createDraft({platform:'youtube',account:channel,text:'new',weightedLength:3});
  assert.equal(draft.platform,'youtube');
  assert.equal(draft.channel_id,channel);
  assert.equal(store.getDraft('old-x-draft').text,'unchanged');
});

test('platform routing rejects the wrong publisher and YouTube retries do not resend',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'simsima-platform-'));
  let sends=0;
  const service=new AgentService({dataDir:dir},{publisher:{async publish(){throw new Error('X must not be invoked');}},
    youtubePublisher:{async publish(draft,hooks){sends++;assert.equal(draft.platform,'youtube');await hooks.onSubmitting();return {post_id:post,post_url:`https://www.youtube.com/post/${post}`,evidence:{permalink_verified:true}};}}});
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const yt=await service.prepareYouTubePost({text:'نص طويل '+ 'ع'.repeat(300),channel_id:channel});
  const input={draft_id:yt.draft_id,request_id:'youtube-test-001'};
  await assert.rejects(service.publishPost(input),{code:'platform_mismatch'});
  const x=await service.preparePost({text:'hello',account:'alice'});
  await assert.rejects(service.publishYouTubePost({draft_id:x.draft_id,request_id:'wrong-platform-001'}),{code:'platform_mismatch'});
  assert.equal((await service.publishYouTubePost(input)).status,'succeeded');
  assert.equal((await service.publishYouTubePost(input)).replayed,true);
  assert.equal(sends,1);
});

test('YouTube response evidence validates the canonical URL, channel and text',()=>{
  const draft={account:channel,text:'نص المنشور',image_sha256:'image-hash'};
  const renderer={postId:post,authorEndpoint:{browseEndpoint:{browseId:channel}},contentText:{runs:[{text:draft.text}]},backstageAttachment:{postMultiImageRenderer:{images:[{}]}}};
  const result=parseYouTubeCreateResponse({actions:[{createBackstagePostAction:{backstagePostRenderer:renderer}}]},draft);
  assert.equal(result.post_url,`https://www.youtube.com/post/${post}`);
  assert.equal(youtubePostFields(renderer).image_count,1);
  assert.throws(()=>parseYouTubeCreateResponse({postId:post,contentText:{simpleText:'wrong'}},draft),{code:'published_content_mismatch'});
  assert.throws(()=>parseYouTubePostUrl(`https://example.com/post/${post}`),{code:'invalid_post_url'});
  assert.throws(()=>parseYouTubeCreateResponse({error:{message:'rejected'}},draft),{code:'youtube_publish_unverified'});
});

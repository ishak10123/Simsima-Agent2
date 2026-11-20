import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { HeadlessBraveConnection } from '../src/browser.js';
import { AgentService } from '../src/service.js';

const channel='UCabcdefghijklmnopqrstuv';
const postId='Ugkxabcdefghijklmnopqrstuv';
const baseConfig=loadConfig();
let installed=true;
try {await access(baseConfig.bravePath);}catch{installed=false;}

test('YouTube publisher through real headless Brave with intercepted fixtures', {skip:!installed,timeout:90000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'simsima-youtube-browser-'));
  const config={...baseConfig,profileDir:join(dir,'profile'),dataDir:join(dir,'data'),timeoutMs:3000};
  const connection=new HeadlessBraveConnection(config);
  const service=new AgentService(config,{connection});
  t.after(async()=>{await service.shutdown();await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:200});});
  let handle='TestChannel';
  let reject=false;
  let brokenUpload=false;
  let submissions=0;
  let stalePostViews=0;
  let postViews=0;
  let last={text:'',image:false};
  const renderer=()=>({postId,authorEndpoint:{browseEndpoint:{browseId:channel}},contentText:{runs:[{text:last.text}]},
    ...(last.image?{backstageAttachment:{postMultiImageRenderer:{images:[{backstageImageRenderer:{image:{thumbnails:[]}}}]}}}:{})});
  const original=connection.withContext.bind(connection);
  connection.withContext=fn=>original(async(context,browser)=>{
    await context.route('**/*',async route=>{
      const request=route.request();
      const url=new URL(request.url());
      if(url.hostname!=='www.youtube.com')return route.abort();
      if(url.pathname==='/youtubei/v1/backstage/create_post'){
        submissions++;
        last=request.postDataJSON();
        return route.fulfill({json:reject?{error:{message:'fixture rejection'}}:{actions:[{createBackstagePostAction:{backstagePostRenderer:renderer()}}]}});
      }
      const postPage=url.pathname.startsWith('/post/');
      if(postPage){
        postViews++;
        if(stalePostViews>0){stalePostViews--;return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Post not ready yet</title>'});}
      }
      const channelPage=url.pathname.endsWith('/posts');
      const metadata=channelPage?{channelMetadataRenderer:{externalId:channel,title:'Test channel',vanityChannelUrl:'http://www.youtube.com/@TestChannel'}}:{};
      const html=`<!doctype html><meta charset="utf-8"><div id="avatar-slot"></div>
        <ytd-active-account-header-renderer style="display:none"><a href="/@${handle}">Your channel</a></ytd-active-account-header-renderer>
        ${postPage?'<ytd-backstage-post-renderer style="display:block;min-height:40px">Published post</ytd-backstage-post-renderer>':`
          <ytd-backstage-post-dialog-renderer style="display:block">
            <div id="placeholder-area">Share an update</div>
            <div id="creation-box" style="display:none">
              <div id="contenteditable-root" contenteditable="true" style="border:1px solid;min-height:40px"></div>
              <button aria-label="Add image" id="image-button">Image</button>
              <ytd-backstage-multi-image-select-renderer style="display:none">
                <div id="dropzone"><input type="file" accept="image/*"></div><div id="preview"></div>
              </ytd-backstage-multi-image-select-renderer>
              <div id="submit-button"><button disabled>Post</button></div>
            </div>
          </ytd-backstage-post-dialog-renderer>`}
        <script>
          window.ytcfg={get:key=>key==='LOGGED_IN'?true:null};
          window.ytInitialData={metadata:${JSON.stringify(metadata)}};
          setTimeout(()=>{
            document.querySelector('#avatar-slot').innerHTML='<button id="avatar-btn">Account</button>';
            document.querySelector('#avatar-btn').onclick=()=>document.querySelector('ytd-active-account-header-renderer').style.display='block';
          },100);
          document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('ytd-active-account-header-renderer').style.display='none';});
          ${postPage?`document.querySelector('ytd-backstage-post-renderer').data=${JSON.stringify(renderer())};`:`
            const root=document.querySelector('ytd-backstage-post-dialog-renderer');
            const editor=root.querySelector('[contenteditable]');
            const input=root.querySelector('input');
            const button=root.querySelector('#submit-button button');
            root.querySelector('#placeholder-area').onclick=()=>{root.querySelector('#creation-box').style.display='block';root.querySelector('#placeholder-area').style.display='none';};
            editor.oninput=()=>{button.disabled=!editor.innerText.trim();};
            root.querySelector('#image-button').onclick=()=>{root.querySelector('ytd-backstage-multi-image-select-renderer').style.display='block';};
            input.onchange=()=>{
              if(${brokenUpload})return;
              const image=document.createElement('img');image.width=40;image.height=40;image.src=URL.createObjectURL(input.files[0]);root.querySelector('#preview').append(image,image.cloneNode());
            };
            button.onclick=()=>fetch('/youtubei/v1/backstage/create_post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:editor.innerText,image:input.files.length>0})});
          `}
        </script>`;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
    });
    return fn(context,browser);
  });

  await t.test('reads active channel and publishes text after expanding the collapsed editor',async()=>{
    assert.equal((await service.youtubeAccountStatus()).channel_id,channel);
    const draft=await service.prepareYouTubePost({text:'نص تجريبي للقناة',channel_id:channel});
    const input={draft_id:draft.draft_id,request_id:'youtube-browser-text-001'};
    const result=await service.publishYouTubePost(input);
    assert.equal(result.status,'succeeded',JSON.stringify(result));
    assert.equal(result.evidence.permalink_verified,true);
    assert.equal((await service.publishYouTubePost(input)).replayed,true);
    assert.equal(submissions,1);
  });
  await t.test('uploads exactly one image and verifies the resulting attachment',async()=>{
    const path=join(dir,'image.png');
    await writeFile(path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
    const draft=await service.prepareYouTubePost({text:'نص وصورة',channel_id:channel,image_path:path});
    const result=await service.publishYouTubePost({draft_id:draft.draft_id,request_id:'youtube-browser-image-001'});
    assert.equal(result.status,'succeeded',JSON.stringify(result));
    assert.equal(result.evidence.image_count,1);
    assert.equal(submissions,2);
  });
  await t.test('wrong active channel cannot publish to the expected channel',async()=>{
    handle='OtherChannel';
    const draft=await service.prepareYouTubePost({text:'do not send',channel_id:channel});
    const result=await service.publishYouTubePost({draft_id:draft.draft_id,request_id:'youtube-browser-wrong-001'});
    assert.equal(result.status,'failed');assert.equal(result.error.code,'youtube_channel_mismatch');assert.equal(submissions,2);
    handle='TestChannel';
  });
  await t.test('a missing image preview stops before sending text alone',async()=>{
    brokenUpload=true;
    const draft=await service.prepareYouTubePost({text:'image required',channel_id:channel,image_path:join(dir,'image.png')});
    const result=await service.publishYouTubePost({draft_id:draft.draft_id,request_id:'youtube-browser-missing-001'});
    assert.equal(result.status,'failed');assert.equal(submissions,2);brokenUpload=false;
  });
  await t.test('an unconfirmed submission stays uncertain and cannot resend',async()=>{
    reject=true;
    const draft=await service.prepareYouTubePost({text:'uncertain',channel_id:channel});
    const input={draft_id:draft.draft_id,request_id:'youtube-browser-uncertain-001'};
    assert.equal((await service.publishYouTubePost(input)).status,'uncertain');
    assert.equal((await service.publishYouTubePost(input)).replayed,true);assert.equal(submissions,3);
    await assert.rejects(service.publishYouTubePost({...input,request_id:'youtube-browser-resend-001'}),{code:'draft_already_submitted'});
  });
  await t.test('a stale first permalink response is refreshed without another publish request',async()=>{
    reject=false;stalePostViews=1;
    const beforeSends=submissions;const beforeViews=postViews;
    const draft=await service.prepareYouTubePost({text:'fresh post',channel_id:channel});
    const result=await service.publishYouTubePost({draft_id:draft.draft_id,request_id:'youtube-browser-refresh-001'});
    assert.equal(result.status,'succeeded',JSON.stringify(result));
    assert.equal(result.evidence.verification_reloaded,true);
    assert.equal(submissions,beforeSends+1);
    assert.equal(postViews,beforeViews+2);
  });
});

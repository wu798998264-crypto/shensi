import assert from 'node:assert/strict';
import { mkdtemp,readFile,stat,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createImagePreviewCache } from '../src/server/image-preview-cache.mjs';
const root=await mkdtemp(join(tmpdir(),'shensi-image-preview-'));
try {
  const absolutePath=new URL('../public/assets/shensi-app-icon.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
  const sourcePath=decodeURIComponent(absolutePath);
  const before=await readFile(sourcePath);
  const content={absolutePath:sourcePath,size:(await stat(sourcePath)).size,mimeType:'image/png'};
  let runs=0;
  const preview=createImagePreviewCache({directory:root,executable:join(process.cwd(),'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),run:(...args)=>{runs++;return spawn(...args);}});
  const copies=await Promise.all(Array.from({length:8},()=>preview(content)));
  assert.equal(runs,1,'同一素材多个卡片只生成一份缓存');
  assert.notEqual(copies[0].absolutePath,sourcePath);
  assert.ok(copies.every(x=>x.absolutePath===copies[0].absolutePath));
  const bytes=await readFile(copies[0].absolutePath);
  assert.ok(bytes.readUInt32BE(16)<=640&&bytes.readUInt32BE(20)<=640);
  await preview(content);assert.equal(runs,1);
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'),createHash('sha256').update(before).digest('hex'));
  const video={...content,mimeType:'video/mp4'};
  assert.equal(await preview(video),video,'视频不进入图片缓存通道');
} finally { await rm(root,{recursive:true,force:true}); }
console.log('Image preview cache: original bytes retained, bounded dimensions, shared work and cached reuse passed');

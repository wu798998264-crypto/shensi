import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Display cache only. The caller must first authorize/resolve the attachment.
// Original assets, their hashes and all generation transactions are untouched.
export const createImagePreviewCache = ({ directory, executable, run = spawn }) => {
  const pending = new Map();
  const waiters = [];
  let active = 0;
  let writes = 0;
  let trimming = false;
  const trim = async () => {
    if (trimming) return;
    trimming = true;
    try {
      const files = [];
      for (const name of await readdir(directory)) {
        // Only files produced by this cache; never inspect/delete originals.
        if (!/^[a-f0-9]{64}\.png$/u.test(name)) continue;
        const path = join(directory,name), info = await stat(path).catch(()=>null);
        if (info?.isFile()) files.push({path,size:info.size,time:info.mtimeMs});
      }
      let bytes = files.reduce((sum,file)=>sum+file.size,0);
      for (const file of files.sort((a,b)=>a.time-b.time)) {
        if (bytes <= 512*1024*1024) break;
        // Keep files currently being streamed by the visible board.
        if (Date.now()-file.time < 60_000) continue;
        await rm(file.path,{force:true}).catch(()=>{}); bytes-=file.size;
      }
    } finally { trimming=false; }
  };
  const acquire = async () => {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve));
    else active++;
  };
  const release = () => { if (waiters.length) waiters.shift()(); else active--; };
  return async content => {
    if (!/^image\/(png|jpeg|webp)$/u.test(content.mimeType) || !executable || !existsSync(executable)) return content;
    const info = await stat(content.absolutePath);
    const key = createHash('sha256').update(`${content.absolutePath}:${info.size}:${info.mtimeMs}:640:v1`).digest('hex');
    const target = join(directory, `${key}.png`);
    const ready = async () => {
      const s = await stat(target).catch(() => null);
      return s?.size ? { ...content, absolutePath: target, size: s.size, mimeType: 'image/png' } : null;
    };
    const cached = await ready();
    if (cached) return cached;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      await acquire();
      const temporary = join(directory, `${key}-${randomUUID()}.png`);
      try {
        const raced = await ready(); if (raced) return raced;
        await mkdir(directory, { recursive: true });
        await new Promise((resolve, reject) => {
          const child = run(executable, ['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
            '-i',content.absolutePath,'-frames:v','1','-vf',"scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",'-threads','1','-compression_level','1','-y',temporary],
          { windowsHide:true, shell:false, stdio:'ignore' });
          const timer = setTimeout(() => { child.kill(); reject(new Error('preview-timeout')); }, 15000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('preview-failed')); });
        });
        const bytes = await readFile(temporary);
        if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('invalid-preview');
        await rename(temporary,target);
        if (++writes % 64 === 0) void trim().catch(()=>{});
        return await ready() || content;
      } catch { return content; }
      finally { await rm(temporary,{force:true}).catch(()=>{}); release(); }
    })().finally(()=>pending.delete(key));
    pending.set(key,job);
    return job;
  };
};

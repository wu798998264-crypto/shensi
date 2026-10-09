import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const userData=await mkdtemp(join(tmpdir(),'shensi-prompt-dom-'));
const env={...process.env,SHENSI_TEST_PROMPT_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url)),[fileURLToPath(new URL('./fixtures/prompt-clipboard-dom.cjs',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-3500);});
const timer=setTimeout(()=>child.kill(),40_000);
try{
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw new Error(`Isolated DOM fixture failed (${code}): ${errors}`);
  const result=output.split(/\r?\n/u).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.passed);
  if(!result)throw new Error(`No successful DOM test result: ${errors}`);
  console.log(JSON.stringify(result));
}finally{
  clearTimeout(timer);
  if(!resolve(userData).startsWith(resolve(tmpdir())+sep))throw new Error('Refusing cleanup outside the test temp directory');
  await rm(userData,{recursive:true,force:true});
}

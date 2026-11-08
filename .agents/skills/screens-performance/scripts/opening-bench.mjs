#!/usr/bin/env node
// Opening benchmark preparation/collector. Real hosts render LibraryApp; no screens-cli/dev session.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {connectLocalService,contentVersionOf} from '@screens/client';
import {emptyScreen} from '@screens/core';
import {canvasAssets,liveRegistry} from '@screens/service';
import {encodeArchive,archiveFiles} from '@screens/protocol';
import {machine} from './bench-evidence.mjs';
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf(`--${k}`);return i<0?d:args[i+1]};
const out=path.resolve(opt('out','.perf/opening')),home=process.env.SCREENS_HOME;
if(!home||process.env.SCREENS_DEV)throw Error('Explicit disposable production SCREENS_HOME required');
fs.mkdirSync(out,{recursive:true});
const collecting=args.includes('--collect-file');
if(!path.resolve(home).startsWith(`${process.cwd()}/.perf/`))throw Error('Disposable home must be inside this worktree .perf/');
const host=opt('host',args.includes('--app-relay')?'app-relay-control':args.includes('--headless')?'headless-control':'in-app-browser'),reps=7,runId=opt('run',path.basename(out));
if(!['screens-app','in-app-browser','headless-control','app-relay-control'].includes(host))throw Error('Unknown host');
if(args.includes('--headless')&&!['headless-control','app-relay-control'].includes(host))throw Error('Headless control cannot be labeled a native host');
const configFile=path.resolve(opt('config',path.join(out,'config.json'))),resultFile=path.join(out,'results.json');
if(!collecting&&['results.json','app-result.json','failure.json','environment.json','service.log'].some(file=>fs.existsSync(path.join(out,file)))){
 console.error(JSON.stringify({errorCount:1,completedOpenings:0,error:'--out must be a fresh run directory; previous evidence is never overwritten'}));process.exit(2);
}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let serviceProcess,reg,svc,server,browser;
process.on('exit',()=>{if(serviceProcess&&serviceProcess.exitCode===null)serviceProcess.kill('SIGTERM');});
async function startService(config){
 const log=fs.openSync(path.join(out,'service.log'),'a'),env={...process.env,SCREENS_HOME:home};
 delete env.SCREENS_DEV;delete env.SCREENS_OPENING_CONFIG;if(config)env.SCREENS_OPENING_CONFIG=config;
 serviceProcess=spawn(process.execPath,[path.resolve('packages/service/src/cli.ts'),'serve'],{env,stdio:['ignore',log,log]});fs.closeSync(log);
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){const live=await liveRegistry();if(live&&live.pid===serviceProcess.pid){reg=live;if(reg.dev!==false)throw Error('Production service required');return;}if(serviceProcess.exitCode!==null)throw Error('Service failed; inspect service.log');await new Promise(r=>setTimeout(r,100));}
 throw Error('Service did not start');
}
async function stopService(){
 if(!serviceProcess||serviceProcess.exitCode!==null)return;
 const exited=new Promise(r=>serviceProcess.once('exit',r));serviceProcess.kill('SIGTERM');await exited;serviceProcess=undefined;
}
async function cleanup(){await browser?.close();server?.close();svc?.close();await stopService();}
if(!collecting){
 if(await liveRegistry())throw Error('Stop the existing disposable service before this run');
 await startService();
 svc=await connectLocalService({origin:reg.canvasOrigin,token:reg.token,instanceId:reg.instanceId,role:'agent',name:'opening-benchmark'});
}
let errors=0,completed=0;
function vet(result, expected){
 const reasons=[];
 if(result.runId!==expected.runId||result.host!==host||result.revision!==expected.revision||result.serviceInstanceId!==expected.expectedServiceInstanceId)reasons.push('wrong run/host/revision');
 if(JSON.stringify(result.cases)!==JSON.stringify(expected.cases))reasons.push('fixture matrix mismatch');
 if(!result.complete||result.reps!==7||result.repetitions?.length!==expected.cases.length*7)reasons.push('incomplete work');
 if(result.canvasHash!==expected.expectedCanvasHash)reasons.push('bundle fingerprint mismatch');
 if(result.errorCount!==0||!result.doctor?.testHookAbsent||result.doctor?.appSurface!==['screens-app','app-relay-control'].includes(host)||result.doctor?.visibility!=='visible')reasons.push('observer/host doctor errors');
 if(['screens-app','app-relay-control'].includes(host)&&(!result.resourceUri?.startsWith('ui://')||result.adapterIdentity?.source!=='worktree'))reasons.push('missing worktree app identity');
 const seen=new Set();
 for(const r of result.repetitions??[]){
  const c=expected.cases.find(c=>c.id===r.caseId),key=`${r.caseId}/${r.rep}`;
  if(!c||r.screenId!==c.screenId||!Number.isInteger(r.rep)||r.rep<0||r.rep>=7||seen.has(key))reasons.push(`wrong repetition ${key}`);
  seen.add(key);
  if(r.mode!==(r.rep===0?'first-open-in-view':'warm-reopen')||!Number.isFinite(r.milestones?.firstContent)||r.milestones.firstContent<0||r.milestones.firstContent>r.milestones.viewportCoverage||r.milestones.viewportCoverage>r.milestones.allScheduledLiveReady||r.milestones.allScheduledLiveReady>r.milestones.settled)reasons.push(`milestone/mode mismatch ${key}`);
  const expectedDoc=expected.documents?.[r.caseId];if(!expectedDoc||r.contentSignature!==expectedDoc)reasons.push(`fixture digest mismatch ${key}`);
  if(r.events.some(e=>e.stage==='admission'&&e.details.live>r.cap))reasons.push(`transient cap violation ${key}`);
  if(r.status!=='complete'||!Number.isFinite(r.milestones?.viewportCoverage)||!Number.isFinite(r.milestones?.allScheduledLiveReady)||!Number.isFinite(r.milestones?.settled))reasons.push(`unsettled ${key}`);
  if(!r.targets?.length||r.coverage?.usableItems!==r.targets.length||r.coverage?.targetItems!==r.targets.length||Math.abs(r.coverage.usableArea-r.coverage.targetArea)>0.1)reasons.push(`incomplete current coverage ${key}`);
  if((![6,16].includes(r.cap)||r.maxLive>r.cap)||!Array.isArray(r.scheduled)||r.scheduled.length>r.cap||r.maxRafGap>3000||!r.contentSignature)reasons.push(`invariant failure ${key}`);
 }
 return {errorCount:reasons.length,reasons};
}
function stats(xs){const s=[...xs].sort((a,b)=>a-b);return {n:s.length,median:s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null,min:s[0]??null,max:s.at(-1)??null};}
function save(result){
 const expected=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const checklist=vet(result,expected); errors+=checklist.errorCount; completed++;
 const summary=result.cases.map(c=>({id:c.id,items:c.items,modes:['first-open-in-view','warm-reopen'].map(mode=>{
  const rows=result.repetitions.filter(r=>r.caseId===c.id&&r.mode===mode);return {mode,n:rows.length,metrics:Object.fromEntries(['firstContent','viewportCoverage','allScheduledLiveReady','settled'].map(k=>[k,stats(rows.map(r=>r.milestones[k]).filter(Number.isFinite))]))};
 })}));
 fs.writeFileSync(resultFile,JSON.stringify({...result,checklist,summary},null,2));
 console.log(JSON.stringify({resultFile,errorCount:errors,completedOpenings:result.repetitions.length,summary:summary.map(c=>({id:c.id,warm:c.modes[1].metrics}))}));
}
if(args.includes('--collect-file')){save(JSON.parse(fs.readFileSync(opt('collect-file'),'utf8')));process.exitCode=errors?1:0;}
else {
 const counts=opt('items','16,500').split(',').map(Number),types=opt('content','stored,bundle,on-demand').split(',');
 const fixtureDir=path.resolve(opt('fixtures','.perf/opening/fixtures'));fs.mkdirSync(fixtureDir,{recursive:true});
 if(counts.some(n=>!Number.isInteger(n)||n<1||n>500)||types.some(t=>!['stored','bundle','on-demand','animated'].includes(t)))throw Error('Invalid fixture matrix');
 const existing=await svc.listScreens(),cases=[],fixtures=[];
 for(const type of types)for(const n of counts){
  // Large-bundle slice is bounded; 500 posters provides sensitivity without 500 MB of relay traffic.
  if(type!=='stored'&&n>16)continue;
  const id=`${type}-${n}`,title=`opening-v1-${id}`,archiveFile=path.join(fixtureDir,`${id}.screens`);let screen=existing.find(s=>s.title===title&&s.itemCount===n);
  if(!screen&&fs.existsSync(archiveFile)){const imported=await svc.importScreen(fs.readFileSync(archiveFile));if(imported.status!=='committed')throw Error(`Frozen fixture import: ${JSON.stringify(imported)}`);screen={id:imported.screenId};}
  if(!screen){
   const html=new TextEncoder().encode(`<!doctype html><html><head>${type==='bundle'?'<link rel="stylesheet" href="payload.css">':''}<style>body{margin:0;padding:20px;font:18px system-ui;background:#e8f2ff;color:#16385f}button{font:inherit;padding:8px}</style></head><body><h1>Opening fixture</h1><p>Self-contained snapshot</p>${type==='animated'?'<div id=animation></div><script>const el=document.getElementById("animation");el.style.cssText="width:60px;height:30px;background:#e64";function tick(t){el.style.transform="translateX("+(t/10%100)+"px)";requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>':''}<button onclick="this.textContent='Clicked'">Interact</button></body></html>`);
   const files=[{hash:await svc.upload(html),mediaType:'text/html',bytes:html}],manifest={'index.html':{hash:files[0].hash,mediaType:'text/html'}};
   if(type==='bundle'){const bytes=new TextEncoder().encode('/*'+'x'.repeat(1000000)+'*/\nbody{border:4px solid #3575c4}');const h=await svc.upload(bytes);files.push({hash:h,mediaType:'text/css',bytes});manifest['payload.css']={hash:h,mediaType:'text/css'};}
   const version=await contentVersionOf('index.html',manifest);
   // One genuine service-validated poster; replicate the immutable snapshot with the import domain operation.
   const seed=await svc.createScreen(`opening-seed-${id}`);
   const outcome=await svc.run(seed.id,{type:'addItem',item:{kind:'html-snapshot',id:'seed',title:'Opening fixture',x:0,y:0,width:240,height:160,entry:'index.html',assetManifest:manifest,contentVersion:version,sourceReferenceIds:[]}});
   if(outcome.status!=='committed')throw Error(`Fixture validation failed: ${JSON.stringify(outcome)}`);
   const template=(await svc.read(seed.id)).items.seed;
   if(!template.posterHash)throw Error('Validated fixture has no poster');
   const poster=await svc.readContent(template.posterHash);files.push({hash:template.posterHash,mediaType:'image/jpeg',bytes:poster});
   const doc={...emptyScreen(crypto.randomUUID(),title,Date.now()),revision:1},cols=Math.ceil(Math.sqrt(n));
   for(let i=0;i<n;i++)doc.items[`o${i}`]={...template,id:`o${i}`,title:`Frame ${i}`,x:(i%cols)*300,y:Math.floor(i/cols)*220,z:i,posterHash:type==='on-demand'?null:template.posterHash};
   const archiveFilesData=await Promise.all(archiveFiles(doc).map(async f=>({...f,bytes:await svc.readContent(f.hash)})));
   const archive=Buffer.concat(encodeArchive(doc,archiveFilesData));const imported=await svc.importScreen(archive);
   if(imported.status!=='committed')throw Error(`Fixture import failed: ${JSON.stringify(imported)}`);
   screen={id:imported.screenId};
  }
  if(!fs.existsSync(archiveFile)){const exported=await svc.exportScreen(screen.id);fs.writeFileSync(archiveFile,Buffer.concat(exported.parts),{flag:'wx'});}
  const doc=await svc.read(screen.id);cases.push({id,screenId:screen.id,items:n});fixtures.push({id,screenId:screen.id,documentHash:hash(JSON.stringify(doc)),items:n,posters:Object.values(doc.items).filter(i=>i.posterHash).length,posterCacheSemantics:type==='on-demand'?'Library cover request may warm shared generated poster before timed opening':'stored poster',uniqueAssets:[...new Set(Object.values(doc.items).flatMap(i=>Object.values(i.assetManifest).map(a=>a.hash)))],geometry:'240x160; 60x60 gap; ceil(sqrt(N)) columns; production initial fit-all'});
 }
 const token=crypto.randomBytes(24).toString('hex');
 server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',reg.canvasOrigin);res.setHeader('Access-Control-Allow-Headers','content-type,x-screens-opening-token');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.method!=='POST'||req.headers.origin!==reg.canvasOrigin||req.headers['x-screens-opening-token']!==token){res.writeHead(403).end();return;}
  const chunks=[];let bytes=0;req.on('data',b=>{bytes+=b.length;if(bytes>8*1024*1024)req.destroy();else chunks.push(b)});req.on('end',()=>{try{save(JSON.parse(Buffer.concat(chunks).toString()));res.end('ok')}catch(e){errors++;res.writeHead(400).end(String(e))}});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const expectedCanvasHash=hash((await canvasAssets({testHook:false})).js);
 const config={runId,host,cases,reps,expectedCanvasHash,documents:Object.fromEntries(fixtures.map(f=>[f.id,f.documentHash])),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),collector:`http://127.0.0.1:${server.address().port}/result`,token};
 fs.mkdirSync(path.dirname(configFile),{recursive:true});fs.writeFileSync(configFile,JSON.stringify(config,null,2));
 svc.close();svc=undefined;await stopService();
 await startService(configFile);
 config.expectedServiceInstanceId=reg.instanceId;
 fs.writeFileSync(configFile,JSON.stringify(config,null,2));
 const provenance={config:{...config,token:undefined},fixtures,service:{dev:reg.dev,instanceId:reg.instanceId},environment:{...machine(),arch:process.arch},harness:Object.fromEntries(['.agents/skills/screens-performance/scripts/opening-bench.mjs','packages/canvas/src/shell/opening.ts','packages/client/src/diagnostics.ts'].map(f=>[f,hash(fs.readFileSync(f))]))};
 fs.writeFileSync(path.join(out,'environment.json'),JSON.stringify(provenance,null,2));
 console.log(JSON.stringify({url:`${reg.canvasOrigin}/`,configFile,resultFile,host,cases:cases.length,expectedOpenings:cases.length*reps,doctor:{production:true,errorCount:0,completedChecks:2}}));
 if(args.includes('--headless')){
  try{
   const {chromium}=await import('playwright-core');browser=await chromium.launch({channel:'chrome',headless:true});
   if(args.includes('--app-relay')){
    const {runOpeningAppControl}=await import('../../../../packages/cli/src/opening-host.ts');const control=await runOpeningAppControl(browser,home,configFile,out);
    if(control.errors.length||control.localRequests.length)throw Error(`App relay control: ${JSON.stringify(control)}`);
    save(JSON.parse(fs.readFileSync(path.join(out,'app-result.json'),'utf8')));
   }else{
   const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:2});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
   await page.goto(reg.canvasOrigin);await page.getByRole('button',{name:'Start opening benchmark',exact:true}).click();
   await page.getByRole('status').filter({hasText:`${cases.length*reps} openings recorded`}).waitFor({timeout:180000});
   if(pageErrors.length||!fs.existsSync(resultFile))throw Error(`Missing result or browser errors: ${pageErrors}`);
   }
   if(JSON.parse(fs.readFileSync(resultFile)).checklist.errorCount)errors++;
  }catch(error){errors++;fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({errorCount:errors,error:String(error)}));console.error(error);}
  finally{await cleanup();process.exitCode=errors?1:0;}
 }else{
  const stop=async()=>{await cleanup();process.exitCode=errors?1:0;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 }
}

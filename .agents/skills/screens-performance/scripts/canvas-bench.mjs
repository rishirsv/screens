#!/usr/bin/env node
// Production benchmark: headless/headed Chrome, or a local collector for the visible in-app browser.
// canvas-bench.mjs --out DIR [--items 1,16,50,200,500] [--content static,css-animated,...]
//   [--reps 5] [--host in-app-browser] [--profile [--work-cpu --cpu-pid PID]] [--idle --cpu-pid PID]
//   [--frame-ready --probe-dir DIR --headed] [--doctor]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { machine, vet, processTimes, cpuDelta, stats, traceWork, sampledCpu } from './bench-evidence.mjs';
const args=process.argv.slice(2), opt=(k,d)=>{const i=args.indexOf(`--${k}`);return i>=0?args[i+1]:d};
const out=opt('out');if(!out)throw new Error('--out DIR required');fs.mkdirSync(out,{recursive:true});
const home=process.env.SCREENS_HOME??path.join(os.homedir(),'.screens');
const reg=JSON.parse(fs.readFileSync(path.join(home,'service.json'),'utf8'));
if(reg.dev!==false)throw new Error('registry must explicitly identify a production service');
const host=opt('host',args.includes('--headed')?'chrome-headed':'chrome-headless'), reps=Number(opt('reps','5'));
const workCpu=args.includes('--work-cpu');
const profile=args.includes('--profile'), idle=args.includes('--idle'), doctor=args.includes('--doctor'), frameReady=args.includes('--frame-ready');
const items=opt('items',idle?'16':'1,16,50,200,500'), content=opt('content',idle?'css-animated':'static,css-animated,js-animated,media,scrollable,failing,heavy');
if(reps<5||!Number.isInteger(reps))throw new Error('at least 5 repetitions required');
if(process.env.SCREENS_DEV)throw new Error('production service required; unset SCREENS_DEV');
const environment={...machine(),harness:Object.fromEntries(['packages/canvas/src/shell/bench.ts','.agents/skills/screens-performance/scripts/canvas-bench.mjs','.agents/skills/screens-performance/scripts/bench-evidence.mjs'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),host,build:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),production:true,profile,guiPreflight:host.startsWith('chrome')?'caller must use macOS GUI preflight':null};
fs.writeFileSync(path.join(out,'environment.json'),JSON.stringify(environment,null,2));
let browser,rootPid=Number(opt('cpu-pid','0')), errors=0;
const results=[],cpuRuns=[],workRuns=[],workStarts=new Map();let cpuStart=null,cpuPhase=null;
if(!['chrome-headless','chrome-headed','in-app-browser'].includes(host))throw new Error('unsupported benchmark host');
if(profile&&host==='in-app-browser'&&!workCpu)throw new Error('native work pass requires --work-cpu --cpu-pid PID');
if(workCpu&&(!profile||host!=='in-app-browser'||!rootPid))throw new Error('--work-cpu requires --profile --host in-app-browser --cpu-pid PID');
function phase(data){
  const now=processTimes(rootPid,true);
  if(!now.processes.some(p=>p.pid===rootPid))throw new Error(`OS sampler root ${rootPid} is not running`);
  if(!cpuStart)console.log(JSON.stringify({doctor:"OS ps CPU sampler",rootPid,processes:now.processes.length,completedChecks:1,errorCount:0}));
  if(cpuStart && cpuPhase && ['still','moving'].includes(cpuPhase.phase))cpuRuns.push({...cpuPhase,...cpuDelta(cpuStart,now)});
  cpuStart=now;cpuPhase=data;
}
function workPhase(data){
  const sample=processTimes(rootPid,true), key=`${data.content}/${data.items}/${data.rep}`;
  if(!sample.processes.some(p=>p.pid===rootPid))throw new Error('OS work trace root missing');
  if(data.ready!==data.live||data.live<1)throw new Error('OS work trace has unready frames');
  if(data.phase==='start'){
    if(workStarts.has(key))throw new Error('duplicate OS work start');
    const state={samples:[sample],data,timer:null};state.timer=setInterval(()=>state.samples.push(processTimes(rootPid,true)),100);workStarts.set(key,state);return;
  }
  const start=workStarts.get(key);if(!start)throw new Error('OS work trace end without start');
  clearInterval(start.timer);start.samples.push(sample);const delta=sampledCpu(start.samples);
  if(data.frames!==90||!Number.isFinite(delta.cpuSeconds)||delta.cpuSeconds<=0)throw new Error('invalid sampled OS work window');
  workRuns.push({...data,...delta,liveAtStart:start.data.live,readyAtStart:start.data.ready,meanMsPerFrame:delta.cpuSeconds*1000/data.frames});workStarts.delete(key);
}
function save(r){
  r.host=host;r.environment=environment;r.checklist=vet(r,host);r.errorCount=Math.max(r.errorCount,r.checklist.errorCount);
  errors+=r.errorCount;results.push(r);
  fs.writeFileSync(path.join(out,`canvas-${r.content}-${r.items}.json`),JSON.stringify(r,null,2));
  console.log(`${r.content}/${r.items}: reps ${r.runs.length}/${r.reps}, frame p95 ${r.cameraFrameTimeMs.p95?.toFixed(2)} ms, live ${r.liveFrames.settled.join('/')}, max ${r.liveFrames.max}, errors ${r.errorCount}`);
}
const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',reg.canvasOrigin);res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type');
  if(req.method==='OPTIONS'){res.end();return}
  if(req.method!=='POST'||req.headers.origin!==reg.canvasOrigin){res.writeHead(403).end();return}
  const chunks=[];let bytes=0;req.on('data',b=>{chunks.push(b);bytes+=b.length;if(bytes>10e6)req.destroy()});req.on('end',()=>{
    try{
      const body=Buffer.concat(chunks);
      if(req.url==='/screenshot'&&host==='in-app-browser'){fs.writeFileSync(path.join(out,'screenshot.png'),body);res.end('ok');return}
      const data=JSON.parse(body.toString('utf8'));if(req.url==='/work-phase'){workPhase(data);res.end('ok');return}if(req.url==='/phase'){if(!rootPid)throw new Error('CPU root PID required');phase(data)}else save(data);res.end('ok')}
    catch(e){errors++;res.writeHead(400).end(String(e));console.error(e)}
  });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const collector=`http://127.0.0.1:${server.address().port}/result`;
const q=new URLSearchParams({items,content,reps:String(reps),label:path.basename(out),collector});
if(profile)q.set('profile','1');if(workCpu)q.set('workCpu','1');if(idle)q.set('idle','1');
const url=`${reg.canvasOrigin}/bench?${q}`;
async function finish(){
  if(!frameReady&&results.length!==items.split(',').length*content.split(',').length)errors++;
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  if(workCpu){
    const expected=items.split(',').length*content.split(',').length*reps;
    if(workRuns.length!==expected||workStarts.size)errors++;
    const scope='Sampled OS CPU-time lower bound of the whole Codex app tree, excluding sampler subtree; includes app UI/service/agent activity, excludes GPU device time; can miss short-lived processes and CPU after the last sample before exit';
    fs.writeFileSync(path.join(out,'work-cpu-trace.json'),JSON.stringify({host,environment,rootPid,errorCount:errors,scope,sampler:'OS ps cumulative CPU counters every 100 ms plus phase boundaries; centisecond resolution; retain per-PID observed high water through exit',work:{windows:workRuns.length,expectedWindows:expected,framesPerWindow:90},runs:workRuns},null,2));
    const work=results.map(r=>{const runs=workRuns.filter(x=>x.content===r.content&&x.items===r.items);return {items:r.items,content:r.content,reps:r.reps,errorCount:errors,checklist:vet(r,host),metric:scope,method:'sampled-os-cpu-phase-trace',runs,medianOfRepMeansMs:stats(runs.map(x=>x.meanMsPerFrame))}});
    fs.writeFileSync(path.join(out,'work-time.json'),JSON.stringify(work,null,2));
    console.log(`OS work trace: ${workRuns.length}/${expected} windows, errors ${errors}`);
  }

  if(idle){
    if(cpuRuns.length!==reps*2||cpuRuns.some(x=>x.live!==16||x.exitedPids.length||!Number.isFinite(x.percentOfOneCore)||x.cpuSeconds<=0||x.elapsedMs<1000))errors++;
    const cpu={host,environment,rootPid,reps,errorCount:errors,work:{windows:cpuRuns.length,expectedWindows:reps*2,liveFrames:16},unit:'percent of one logical CPU; 100% = one fully occupied core',scope:host==='in-app-browser'?'entire Codex application process tree, excluding the sampler subtree; includes other app activity':'recorded Chrome process tree; includes browser, renderer and GPU processes',sampler:'OS ps cumulative CPU time, centisecond resolution; phase-boundary deltas, 3-second still timer and 180-frame moving window',summary:Object.fromEntries(['still','moving'].map(phase=>[phase,stats(cpuRuns.filter(x=>x.phase===phase).map(x=>x.percentOfOneCore))])),runs:cpuRuns};
    fs.writeFileSync(path.join(out,'idle-cpu.json'),JSON.stringify(cpu,null,2));
    console.log(`idle CPU windows ${cpuRuns.length}, errors ${errors}`);
  }
  server.close();process.exitCode=errors?1:0;
}
if(host==='in-app-browser'){
  console.log(JSON.stringify({url,collector,out,host,expectedCases:items.split(',').length*content.split(',').length,profile,cpuRootPid:rootPid}));
  // In-app navigation/CDP uses cua_repl, never an alternate browser pretending to be the pane.
  process.on('SIGINT',async()=>{await finish();process.exit(process.exitCode)});
  process.on('SIGTERM',async()=>{await finish();process.exit(process.exitCode)});
}else{
  let traceSession;
  try{
    browser=await chromium.launch({channel:'chrome',headless:!args.includes('--headed')});
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
    if(!rootPid)rootPid=processTimes(process.pid).processes.find(p=>/\/Google Chrome$/.test(p.command))?.pid??0;
    if(idle&&!rootPid)throw new Error('could not identify browser process for OS sampler');
    if(doctor){
      await page.goto(reg.canvasOrigin);
      const checks=await page.evaluate(()=>({devHook:typeof window.__screensTest,loaf:PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),visible:!document.hidden,ua:navigator.userAgent}));
      if(checks.devHook!=='undefined'||!checks.visible||!checks.loaf)throw new Error(`doctor: ${JSON.stringify(checks)}`);
      console.log(JSON.stringify({doctor:{registryDev:reg.dev,...checks},errorCount:0,completedChecks:4}));
    }
    if(frameReady){
      const probe=JSON.parse(fs.readFileSync(path.join(opt('probe-dir'),'run.json'),'utf8'));
      await page.goto(`${probe.canvasOrigin}/?sizes=0,1000000,5000000,20000000&reps=${reps}&label=${path.basename(out)}`);
      await page.waitForFunction(()=>document.title==='frame-probe done',null,{timeout:180000});
      const r=await page.evaluate(()=>window.__probe);r.host=host;r.environment=environment;r.browser=browser.version();
      if(r.errorCount||r.completedMounts!==reps*4||r.summary.some(x=>x.n!==reps))errors++;
      fs.writeFileSync(path.join(out,'frame-ready.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({completedMounts:r.completedMounts,errorCount:r.errorCount,summary:r.summary}));
    }else{
      if(profile){traceSession=await page.context().newCDPSession(page);await traceSession.send('Tracing.start',{traceConfig:{recordMode:'recordAsMuchAsPossible',traceBufferSizeInKb:1048576,includedCategories:['disabled-by-default-devtools.timeline','blink.user_timing']},transferMode:'ReturnAsStream'});}
      const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
      await page.goto(url);
      await page.waitForFunction(()=>['bench done','bench failed'].includes(document.title),null,{timeout:3600000});
      const status=await page.title();if(status!=='bench done'||pageErrors.length){errors++;const pageResults=await page.evaluate(()=>window.__benchResults);fs.writeFileSync(path.join(out,'page-errors.json'),JSON.stringify({status,pageErrors,pageResults},null,2));}
      if(profile){
        const complete=new Promise(resolve=>traceSession.once('Tracing.tracingComplete',resolve));await traceSession.send('Tracing.end');const {stream,dataLossOccurred}=await complete;
        const file=path.join(out,'trace.json'),fd=fs.openSync(file,'w');
        for(;;){const chunk=await traceSession.send('IO.read',{handle:stream,size:4*1024*1024});fs.writeSync(fd,chunk.base64Encoded?Buffer.from(chunk.data,'base64'):chunk.data);if(chunk.eof)break}fs.closeSync(fd);await traceSession.send('IO.close',{handle:stream});
        if(dataLossOccurred)throw new Error('trace reported data loss');
        const work=await traceWork(file,results,reg.canvasOrigin);fs.writeFileSync(path.join(out,'work-time.json'),JSON.stringify(work,null,2));console.log(`trace: ${work.length} workloads, ${work.reduce((s,r)=>s+r.runs.length,0)} repetitions`);
      }
    }
  }catch(e){errors++;console.error(e)}
  finally{await browser?.close();await finish()}
}

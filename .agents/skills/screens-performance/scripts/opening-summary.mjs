#!/usr/bin/env node
// Reduce measured opening results; never substitute a development control for a native host.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const args=process.argv.slice(2),opt=(k)=>{const i=args.indexOf(`--${k}`);return i<0?undefined:args[i+1]};
const baseline=opt('baseline'),candidate=opt('candidate'),control=opt('control'),out=opt('out');
if(!baseline||!candidate||!out)throw Error('--baseline FILE --candidate FILE --out FILE required');
const artifacts=path.resolve('.perf'),destination=path.resolve(out);
if(!destination.startsWith(artifacts+path.sep))throw Error('Keep measurement artifacts inside .perf.');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>{const dir=path.dirname(file),r=JSON.parse(fs.readFileSync(file)),env=JSON.parse(fs.readFileSync(path.join(dir,'environment.json')));if(fs.existsSync(path.join(dir,'failure.json'))||r.errorCount!==0||r.checklist?.errorCount!==0||!r.complete||r.runId!==env.config.runId||r.canvasHash!==env.config.expectedCanvasHash||r.serviceInstanceId!==env.service.instanceId||r.revision!==env.config.revision||JSON.stringify(r.cases)!==JSON.stringify(env.config.cases))throw Error(`Rejected or stale run: ${file}`);return r;};
const before=read(baseline),after=read(candidate),noop=control?read(control):null;
if(before.host!==after.host||(noop&&noop.host!==before.host))throw Error('Never compare hosts');
for(const file of [candidate,...(control?[control]:[])]){
 const source=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'environment.json')));
 const frozen=JSON.parse(fs.readFileSync(path.join(path.dirname(baseline),'environment.json')));
 if(JSON.stringify(source.harness)!==JSON.stringify(frozen.harness))throw Error('Measurement harness changed');
}
if(before.cases.length!==after.cases.length||(noop&&noop.cases.length!==before.cases.length))throw Error('Workload changed');
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null;};
const stats=xs=>({n:xs.length,median:median(xs),min:xs.length?Math.min(...xs):null,max:xs.length?Math.max(...xs):null});
const rows=(r,id)=>r.repetitions.filter(x=>x.caseId===id&&x.mode==='warm-reopen');
function pairedInterval(xs,ys){
 if(xs.length!==ys.length||!xs.length)return null;
 const differences=xs.map((x,i)=>ys[i]-x);let seed=539;
 const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
 const samples=Array.from({length:10000},()=>median(Array.from({length:differences.length},()=>differences[Math.floor(random()*differences.length)]))).sort((a,b)=>a-b);
 return {estimateMs:median(differences),lowMs:samples[250],highMs:samples[9749],method:'paired percentile bootstrap of median differences; 10000 resamples; fixed seed; descriptive at n=6'};
}
function identity(r,file){
 const env=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'environment.json')));
 return {revision:r.revision,canvasHash:r.canvasHash,host:r.host,userAgent:r.userAgent,harness:env.harness,fixtures:env.fixtures,rawPath:path.join('.perf/runs',path.basename(path.dirname(file)),path.basename(file)),rawSha256:hash(fs.readFileSync(file))};
}
function reduced(r){return r.repetitions.map(x=>({caseId:x.caseId,rep:x.rep,mode:x.mode,status:x.status,milestonesMs:x.milestones,viewport:x.viewport,camera:x.camera,cap:x.cap,maxLive:x.maxLive,finalLive:x.scheduled.length,coverage:x.coverage,contentSignature:x.contentSignature,frames:x.frames,maxRafGapMs:x.maxRafGap,framesOver50Ms:x.framesOver50Ms,observerWorkMs:x.sampleWorkMs,heapBeforeBytes:x.heapBeforeBytes,heapAfterBytes:x.heapAfterBytes,browserErrors:x.browserErrors,
 admissions:x.events.filter(e=>e.stage==='admission').map(e=>({atMs:e.start-x.start,durationMs:e.duration,live:e.details.live,retryAfterMs:e.details.retryAfterMs})),
 stages:Object.fromEntries([...new Set(x.events.map(e=>e.stage))].map(stage=>{const events=x.events.filter(e=>e.stage===stage);return [stage,{count:events.length,firstMs:Math.min(...events.map(e=>e.start-x.start)),lastMs:Math.max(...events.map(e=>e.start+(e.duration??0)-x.start)),durationMs:stats(events.filter(e=>e.duration!==undefined).map(e=>e.duration))}]}))}));}
const cases=before.cases.map(c=>{
 if(!after.cases.some(x=>x.id===c.id&&x.items===c.items))throw Error('Workload changed');
 const a=rows(before,c.id),b=rows(after,c.id),n=noop?rows(noop,c.id):null;
 if(a.length!==6||b.length!==6||(n&&n.length!==6))throw Error('Six warm reopens required');
 for(let i=0;i<a.length;i++)for(const field of ['targets','viewport','camera','scheduled','contentSignature']){
  if(JSON.stringify(a[i][field])!==JSON.stringify(b[i][field])||(n&&JSON.stringify(a[i][field])!==JSON.stringify(n[i][field])))throw Error(`Changed ${field}: ${c.id}/${i+1}`);
 }
 return {id:c.id,items:c.items,eligibleLive:b[0].scheduled.length,metrics:Object.fromEntries(['firstContent','viewportCoverage','allScheduledLiveReady','settled'].map(metric=>{
  const av=a.map(r=>r.milestones[metric]),bv=b.map(r=>r.milestones[metric]);
  return [metric,{before:stats(av),after:stats(bv),deltaMs:median(bv)-median(av),improvementPercent:100*(1-median(bv)/median(av)),pairedDifference:pairedInterval(av,bv),sameCodeDifference:n?pairedInterval(av,n.map(r=>r.milestones[metric])):null}];
 }))};
});
const artifact={schemaVersion:1,metric:'opening-latency',host:after.host,scope:'Development control only; no native host performance claim',date:'2026-11-08',errorCount:0,primary:'allScheduledLiveReady for stored-16; firstContent and viewportCoverage are guardrails',paintSemantics:after.paintSemantics,cacheSemantics:after.cacheSemantics,firstOpenSemantics:'One diagnostic first open per workload; six warm reopens; first open is not a cold distribution',stageSemantics:'Spans overlap; duration sums do not decompose elapsed time; observed readiness excludes the separate 400 ms settle check',before:identity(before,baseline),after:identity(after,candidate),control:noop?identity(noop,control):null,cases,repetitions:{before:reduced(before),after:reduced(after)}};
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify({out,errorCount:0,cases:cases.map(c=>({id:c.id,live:c.eligibleLive,readyBefore:c.metrics.allScheduledLiveReady.before,readyAfter:c.metrics.allScheduledLiveReady.after,improvementPercent:c.metrics.allScheduledLiveReady.improvementPercent}))}));

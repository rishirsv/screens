#!/usr/bin/env node
// Evidence reducers for Chrome traces and OS process-tree sampling. No browser launch here.
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const stats = xs => {
  const s = [...xs].sort((a,b)=>a-b), p = x => s.length ? s[Math.min(s.length-1,Math.floor(s.length*x))] : null;
  return { n:s.length, median:p(.5), p95:p(.95), p99:p(.99), min:s[0]??null, max:s.at(-1)??null };
};
export function machine() {
  return { model:os.cpus()[0]?.model, logicalCpus:os.cpus().length, memoryGB:os.totalmem()/1e9, platform:os.platform(), release:os.release(), node:process.version,
    backgroundLoad:execFileSync('ps',['-axo','pid,ppid,%cpu,comm','-r'],{encoding:'utf8'}).trim().split('\n').slice(0,13) };
}
export function vet(r, host) {
  const errors = [...(r.errors??[])];
  if(r.hidden) errors.push('hidden host');
  if(r.harnessVersion!==4 || r.fixtureContentStable!==true)errors.push('wrong harness or unstable fixture content');
  if(r.reps<5 || r.runs?.length!==r.reps) errors.push('incomplete repetitions');
  if(host==='chrome-headless' && !r.userAgent?.includes('HeadlessChrome/')) errors.push('wrong headless host');
  if(host==='in-app-browser' && !r.userAgent?.includes('Electron/') && !r.userAgent?.includes('Codex/') && r.userAgent?.includes('HeadlessChrome/')) errors.push('wrong in-app host');
  if(r.work?.readiness?.some(x=>!x.settled || x.ready!==x.live)) errors.push('unsettled readiness');
  if(r.liveFrames?.violations) errors.push('live cap violated');
  if(r.work?.cameraFrames!==r.reps*(r.idle?180:90)) errors.push('incomplete camera work');
  if(!r.idle && (r.work?.dragMoves!==r.reps*20 || r.work?.commits!==r.reps || r.work?.focuses!==r.reps || r.work?.interactions!==r.reps)) errors.push('incomplete interaction work');
  return { errorCount:errors.length, errors:[...new Set(errors)], completedReps:r.runs?.length??0, requestedReps:r.reps, host };
}
// CPU time from the OS, in seconds, summed across an explicitly recorded process tree.
function seconds(s) { const p=s.split(':').map(Number);return p.reduce((a,b)=>a*60+b,0); }
export function processTimes(rootPid, excludeSampler=false) {
  const lines=execFileSync('ps',['-axo','pid=,ppid=,time=,comm='],{encoding:'utf8'}).trim().split('\n');
  const all=lines.map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);return m?{pid:+m[1],parent:+m[2],cpuSeconds:seconds(m[3]),command:m[4]}:null}).filter(Boolean);
  const ids=new Set([rootPid]); let changed=true;
  while(changed){changed=false;for(const p of all)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);changed=true}}
  // A browser launched by this collector is the target, not sampler overhead.
  const sampler=new Set(excludeSampler&&ids.has(process.pid)?[process.pid]:[]);
  changed=true;while(changed){changed=false;for(const p of all)if(sampler.has(p.parent)&&!sampler.has(p.pid)){sampler.add(p.pid);changed=true}}
  return { at:performance.now(), processes:all.filter(p=>ids.has(p.pid)&&!sampler.has(p.pid)) };
}
export function cpuDelta(a,b) {
  const previous=new Map(a.processes.map(p=>[p.pid,p.cpuSeconds]));
  const missing=a.processes.filter(p=>!b.processes.some(x=>x.pid===p.pid));
  const seconds=b.processes.reduce((s,p)=>s+Math.max(0,p.cpuSeconds-(previous.get(p.pid)??0)),0);
  return { percentOfOneCore:seconds/((b.at-a.at)/1000)*100, elapsedMs:b.at-a.at, cpuSeconds:seconds, exitedPids:missing.map(p=>p.pid), processes:b.processes.map(p=>({pid:p.pid,command:p.command})) };
}
// Sum non-overlapping renderer-main RunTask intervals, clipped to actual camera rAF boundaries.
// Trace is diagnostic, collected separately from the cadence/gesture/commit runs.
export async function traceWork(traceFile, results, canvasOrigin) {
  const events=[];
  for await(const raw of readline.createInterface({input:fs.createReadStream(traceFile),crlfDelay:Infinity})){
    const line=raw.trim().split('],\"metadata\":')[0].replace(/,$/,'');
    if(!line.startsWith('{\"args\"'))continue;
    const e=JSON.parse(line);
    if(e.name==='RunTask'||e.name==='thread_name'||e.name==='TracingStartedInBrowser'||e.name==='FrameCommittedInBrowser'||(e.cat?.includes('blink.user_timing')&&e.name?.startsWith('bench:')))events.push(e);
  }
  const rendererThreads=new Set(events.filter(e=>e.name==='thread_name' && e.args?.name==='CrRendererMain').map(e=>`${e.pid}:${e.tid}`));
  const frames=new Map();
  for(const e of events){
    if(e.name==='TracingStartedInBrowser')for(const f of e.args?.data?.frames??[])frames.set(f.frame,{...f,parent:f.parent});
    if(e.name==='FrameCommittedInBrowser'){const d=e.args?.data;if(d?.frame)frames.set(d.frame,{...frames.get(d.frame),...d});}
  }
  const related=new Set([...frames].filter(([,f])=>f.url?.startsWith(canvasOrigin+'/bench')).map(([id])=>id));
  let changed=true;while(changed){changed=false;for(const [id,f]of frames)if(related.has(f.parent)&&!related.has(id)){related.add(id);changed=true}}
  const pids=new Set([...related].map(id=>frames.get(id)?.processId).filter(x=>typeof x==='number'));
  // The canvas's own timing mark is definitive when frame metadata is absent.
  for(const e of events)if(e.cat?.includes('blink.user_timing')&&e.name?.startsWith('bench:'))pids.add(e.pid);
  const tasks=events.filter(e=>e.ph==='X' && e.name==='RunTask' && rendererThreads.has(`${e.pid}:${e.tid}`) && pids.has(e.pid) && e.dur>0);
  tasks.sort((a,b)=>a.ts-b.ts);
  const maxTask=tasks.reduce((m,e)=>Math.max(m,e.dur),0);
  const lower=(ts)=>{let lo=0,hi=tasks.length;while(lo<hi){const m=(lo+hi)>>>1;if(tasks[m].ts<ts)lo=m+1;else hi=m}return lo};
  const marks=new Map(events.filter(e=>e.cat?.includes('blink.user_timing')&&e.name?.startsWith('bench:')).map(e=>[e.name,e.ts]));
  if(!tasks.length)throw new Error('trace contains no attributed renderer RunTask work');
  return results.map(r=>{
    const runs=r.runs.map(run=>{
      const start=marks.get(`${run.cameraWindow.traceTag}:start`), end=marks.get(`${run.cameraWindow.traceTag}:end`);
      if(start===undefined||end===undefined)throw new Error(`trace missing marks ${run.cameraWindow.traceTag}`);
      const bounds=run.cameraWindow.boundariesMs.map(t=>start+(t-run.cameraWindow.startMs)*1000);
      const local=tasks.slice(lower(bounds[0]-maxTask),lower(bounds.at(-1)));
      const work=[];
      for(let i=1;i<bounds.length;i++){
        let sum=0;
        for(const t of local)if(t.ts<bounds[i]&&t.ts+t.dur>bounds[i-1])sum+=Math.max(0,Math.min(bounds[i],t.ts+t.dur)-Math.max(bounds[i-1],t.ts));
        work.push(sum/1000);
      }
      return {rep:run.rep,workMsPerFrame:stats(work),meanMsPerFrame:work.reduce((a,b)=>a+b,0)/work.length,frames:work.length};
    });
    return {items:r.items,content:r.content,reps:r.reps,errorCount:r.errorCount,checklist:vet(r,r.host),metric:'sum of renderer main-thread RunTask time per camera frame; excludes GPU and compositor',rendererPids:[...pids],runs,medianOfRepMeansMs:stats(runs.map(x=>x.meanMsPerFrame))};
  });
}

// A sampled lower bound: preserve observed CPU from renderer processes that exit.
// Unsampled short-lived processes and CPU after the last observation before exit are not counted.
export function sampledCpu(samples) {
  const first=samples[0], last=samples.at(-1), baseline=new Map(first.processes.map(p=>[p.pid,p.cpuSeconds]));
  const high=new Map(), processes=new Map(), compact=[];let previous=new Map();
  for(const sample of samples){const changed=[];for(const p of sample.processes){processes.set(p.pid,{pid:p.pid,command:p.command});high.set(p.pid,Math.max(high.get(p.pid)??0,p.cpuSeconds));if(previous.get(p.pid)!==p.cpuSeconds)changed.push([p.pid,p.cpuSeconds]);}compact.push({atMs:sample.at-first.at,changed});previous=new Map(sample.processes.map(p=>[p.pid,p.cpuSeconds]));}
  const cpuSeconds=[...high].reduce((sum,[pid,time])=>sum+Math.max(0,time-(baseline.get(pid)??0)),0);
  return {cpuSeconds,elapsedMs:last.at-first.at,sampleCount:samples.length,maxSampleGapMs:Math.max(...samples.slice(1).map((x,i)=>x.at-samples[i].at)),exitedPids:[...high.keys()].filter(pid=>!last.processes.some(p=>p.pid===pid)),processes:[...processes.values()],samples:compact};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--cpu-doctor')) {
  const output = process.argv[process.argv.indexOf('--out') + 1];
  if (!process.argv.includes('--out') || !output) throw new Error('--out FILE required');
  const child = spawn(process.execPath, ['-e', 'const end=performance.now()+1600;while(performance.now()<end){}']);
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const samples = [processTimes(child.pid)];
  const timer = setInterval(() => samples.push(processTimes(child.pid)), 100);
  try { await exited; } finally { clearInterval(timer); }
  samples.push(processTimes(child.pid));
  const result = sampledCpu(samples);
  if (result.cpuSeconds <= 0 || !result.exitedPids.includes(child.pid) || result.sampleCount < 5) throw new Error('sampled CPU child-exit doctor failed');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ errorCount: 0, completedChecks: 3, requestedChildBusyMs: 1600, ...result }, null, 2));
  console.log(JSON.stringify({ doctor: 'sampled OS CPU through child exit', errorCount: 0, completedChecks: 3, cpuSeconds: result.cpuSeconds, samples: result.sampleCount }));
}

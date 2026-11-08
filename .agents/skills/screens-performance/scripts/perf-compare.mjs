#!/usr/bin/env node
// Compare two frame-probe result files (baseline, candidate) per payload size.
// Verdict per size: faster, slower, no measurable difference (ranges overlap), or
// inconclusive (errors, too few runs, or different hosts).
//
// Usage: perf-compare.mjs BASELINE.json CANDIDATE.json [--min-runs 5]

import fs from "node:fs";

const args = process.argv.slice(2);
const minRuns = Number(args[args.indexOf("--min-runs") + 1]) || 5;
const [basePath, candPath] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min-runs");
if (!basePath || !candPath) { console.error("usage: perf-compare.mjs BASELINE.json CANDIDATE.json [--min-runs 5]"); process.exit(2); }

const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const base = load(basePath), cand = load(candPath);
const host = (r) => (r.userAgent.match(/Claude\/[\d.]+/) || r.userAgent.match(/HeadlessChrome\/[\d.]+|Chrome\/[\d.]+/) || ["unknown"])[0];

const problems = [];
if (base.errorCount) problems.push(`baseline has ${base.errorCount} errors`);
if (cand.errorCount) problems.push(`candidate has ${cand.errorCount} errors`);
if (host(base).split("/")[0] !== host(cand).split("/")[0]) problems.push(`different hosts: ${host(base)} vs ${host(cand)}`);

console.log(`baseline  ${basePath}  ${host(base)}  mounts=${base.completedMounts} errors=${base.errorCount}`);
console.log(`candidate ${candPath}  ${host(cand)}  mounts=${cand.completedMounts} errors=${cand.errorCount}`);
console.log("bytes\tbase median (min-max) n\tcand median (min-max) n\tdelta\tverdict");
for (const b of base.summary) {
  const c = cand.summary.find((x) => x.bytes === b.bytes);
  if (!c) { console.log(`${b.bytes}\t-\tmissing in candidate\t-\tinconclusive`); continue; }
  const delta = ((c.medianMs - b.medianMs) / b.medianMs) * 100;
  let verdict;
  if (problems.length || b.n < minRuns || c.n < minRuns) verdict = "inconclusive";
  else if (c.maxMs < b.minMs) verdict = "faster";
  else if (c.minMs > b.maxMs) verdict = "slower";
  else verdict = "no measurable difference";
  const f = (s) => `${s.medianMs.toFixed(1)} (${s.minMs.toFixed(1)}-${s.maxMs.toFixed(1)}) n=${s.n}`;
  console.log(`${b.bytes}\t${f(b)}\t${f(c)}\t${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%\t${verdict}`);
}
if (problems.length) console.log(`inconclusive because: ${problems.join("; ")}`);

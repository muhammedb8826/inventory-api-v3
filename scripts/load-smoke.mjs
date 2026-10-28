import { performance } from 'node:perf_hooks';
const base = process.env.API_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error('Set API_URL and API_TOKEN for an isolated or staging API');
const count = Math.min(200, Math.max(1, Number(process.env.LOAD_REQUESTS ?? 50)));
const concurrency = Math.min(20, Math.max(1, Number(process.env.LOAD_CONCURRENCY ?? 5)));
const samples = []; const failures = []; let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next++ < count) {
    const started = performance.now();
    try {
      const response = await fetch(`${base.replace(/\/$/,'')}/inventory?limit=20`, { headers:{ authorization:`Bearer ${token}` }, signal:AbortSignal.timeout(10000) });
      await response.arrayBuffer(); if (!response.ok) failures.push(response.status);
    } catch { failures.push('network'); }
    samples.push(performance.now()-started);
  }
}));
samples.sort((a,b)=>a-b);
const percentile = n => samples[Math.min(samples.length-1,Math.ceil(samples.length*n)-1)].toFixed(1);
console.log(JSON.stringify({ requests:samples.length, concurrency, failures:failures.length, failureStatuses:[...new Set(failures)], p50ms:percentile(.5), p95ms:percentile(.95), p99ms:percentile(.99) },null,2));
if (failures.length) process.exitCode=1;

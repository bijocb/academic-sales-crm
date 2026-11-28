/**
 * Load test (Phase 15, docs/PERFORMANCE.md). Plain Node 22, no dependencies.
 *
 *   API_URL=http://localhost:4100/api/v1 CRON_SECRET=… CONCURRENCY=50 REQUESTS=1000 node tests/load/run.mjs
 *
 * Needs an API started against a database seeded with `pnpm db:seed:demo` and `scripts/seed-load.ts`.
 * Runs the realistic profile (USERS virtual users with think time), then the stress scenarios (CONCURRENCY requests
 * always in flight). MODE=users runs only the realistic profile. Prints p50 / p95 / p99 / max latency and errors.
 */
const API = process.env.API_URL ?? 'http://localhost:4100/api/v1';
const C = Number(process.env.CONCURRENCY ?? 50);
const N = Number(process.env.REQUESTS ?? 1000);
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass#2026';
const H = { 'x-crm-client': 'web', 'content-type': 'application/json' };

async function call(method, path, token, body) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ms: performance.now() - t0, status: res.status, body: text };
}
async function login(email) {
  const r = await call('POST', '/auth/login', null, { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.body}`);
  return JSON.parse(r.body).accessToken;
}
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

async function scenario(name, n, c, make) {
  const times = [];
  let errors = 0;
  let i = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (i < n) {
        const k = i++;
        const r = await make(k);
        times.push(r.ms);
        if (r.status >= 400) errors++;
      }
    }),
  );
  const wall = (performance.now() - t0) / 1000;
  times.sort((a, b) => a - b);
  const row = {
    action: name,
    requests: n,
    concurrency: c,
    p50: Math.round(pct(times, 50)),
    p95: Math.round(pct(times, 95)),
    p99: Math.round(pct(times, 99)),
    max: Math.round(times[times.length - 1]),
    rps: Math.round(n / wall),
    errors,
  };
  console.log(
    `${name.padEnd(34)} n=${String(n).padStart(5)} c=${String(c).padStart(3)}  p50 ${String(row.p50).padStart(5)} ms  p95 ${String(row.p95).padStart(5)} ms  p99 ${String(row.p99).padStart(5)} ms  max ${String(row.max).padStart(5)} ms  ${String(row.rps).padStart(4)} req/s  errors ${errors}`,
  );
  return row;
}

const bm = await login('brand.india@demo.local');
const admin = await login('admin@demo.local');
const execs = [];
for (let k = 1; k <= 5; k++) execs.push(await login(`load.exec${k}@demo.local`));
const exec = (k) => execs[k % execs.length];

const page = JSON.parse((await call('GET', '/leads?pageSize=200', bm)).body);
console.log(`Leads visible to the brand manager: ${page.total}`);
const ids = page.items.map((l) => l.id);
const month = new Date().toISOString().slice(0, 7);
const from = `${month}-01`;
const to = new Date().toISOString().slice(0, 10);
const brands = JSON.parse((await call('GET', '/brands', bm)).body);
const brandIn = brands.find((b) => b.country === 'IN');
const sources = JSON.parse((await call('GET', `/lead-sources?brandId=${brandIn.id}`, admin)).body);
const web = sources.find((s) => s.channel === 'WEBSITE');
const key = JSON.parse(
  (await call('POST', '/intake-keys', admin, { sourceId: web.id, name: `load-${Date.now()}` }))
    .body,
).key;

const results = [];
// Realistic profile (MODE=users): USERS virtual users for DURATION seconds, each doing a weighted mix of actions
// with THINK_MS pause between them (default 50 users, one action every ~2 s).
if ((process.env.MODE ?? 'users') === 'users') {
  const USERS = Number(process.env.USERS ?? 50);
  const DURATION = Number(process.env.DURATION ?? 60) * 1000;
  const THINK = Number(process.env.THINK_MS ?? 2000);
  const mix = [
    [
      30,
      'Lead list',
      (k) => call('GET', `/leads?page=${1 + (k % 20)}&pageSize=25`, k % 5 ? exec(k) : bm),
    ],
    [
      15,
      'Lead search',
      (k) => call('GET', `/leads?q=Lead%20${100 + (k % 900)}&pageSize=25`, exec(k)),
    ],
    [25, 'Lead detail', (k) => call('GET', `/leads/${ids[k % ids.length]}`, bm)],
    [10, 'Lead timeline', (k) => call('GET', `/leads/${ids[k % ids.length]}/timeline`, bm)],
    [12, 'My tasks', (k) => call('GET', '/tasks', exec(k))],
    [
      5,
      'My dashboard',
      (k) => call('GET', `/reports/summary?from=${from}&to=${to}&mine=true`, exec(k)),
    ],
    [3, 'Brand report', () => call('GET', `/reports/summary?from=${from}&to=${to}`, bm)],
  ];
  const total = mix.reduce((x, m) => x + m[0], 0);
  const per = new Map(mix.map((m) => [m[1], []]));
  const errs = new Map(mix.map((m) => [m[1], 0]));
  const end = performance.now() + DURATION;
  let n = 0;
  await Promise.all(
    Array.from({ length: USERS }, async (_, u) => {
      await new Promise((r) => setTimeout(r, Math.random() * THINK));
      while (performance.now() < end) {
        let r = Math.random() * total;
        const m = mix.find((x) => (r -= x[0]) < 0) ?? mix[0];
        const res = await m[2](u * 1000 + n++);
        per.get(m[1]).push(res.ms);
        if (res.status >= 400) errs.set(m[1], errs.get(m[1]) + 1);
        await new Promise((r2) => setTimeout(r2, THINK * (0.5 + Math.random())));
      }
    }),
  );
  console.log(
    `Realistic profile: ${USERS} users, ${DURATION / 1000} s, ~${THINK} ms think time, ${n} requests`,
  );
  for (const [name, xs] of per) {
    xs.sort((a, b) => a - b);
    const row = {
      action: `${name} (users)`,
      requests: xs.length,
      p50: Math.round(pct(xs, 50)),
      p95: Math.round(pct(xs, 95)),
      max: Math.round(xs[xs.length - 1]),
      errors: errs.get(name),
    };
    console.log(
      `  ${name.padEnd(16)} n=${String(row.requests).padStart(5)}  p50 ${String(row.p50).padStart(5)} ms  p95 ${String(row.p95).padStart(5)} ms  max ${String(row.max).padStart(5)} ms  errors ${row.errors}`,
    );
    results.push(row);
  }
  if (process.env.MODE === 'users') {
    console.log(JSON.stringify(results));
    process.exit(0);
  }
}
results.push(
  await scenario('Lead list (25, newest)', N, C, (k) =>
    call('GET', `/leads?page=${1 + (k % 20)}&pageSize=25`, bm),
  ),
);
results.push(
  await scenario('Lead list (priority sort)', N, C, () =>
    call('GET', '/leads?pageSize=25&sort=priority', bm),
  ),
);
results.push(
  await scenario('Lead search (name)', N, C, (k) =>
    call('GET', `/leads?q=Lead%20${100 + k}&pageSize=25`, bm),
  ),
);
results.push(
  await scenario('My leads (executive)', N, C, (k) =>
    call('GET', '/leads?ownerId=me&pageSize=25', exec(k)),
  ),
);
results.push(
  await scenario('Lead detail', N, C, (k) => call('GET', `/leads/${ids[k % ids.length]}`, bm)),
);
results.push(
  await scenario('Lead timeline', N, C, (k) =>
    call('GET', `/leads/${ids[k % ids.length]}/timeline`, bm),
  ),
);
results.push(await scenario('My tasks (executive)', N, C, (k) => call('GET', '/tasks', exec(k))));
results.push(
  await scenario('Pipeline board', Math.min(N, 300), Math.min(C, 20), () =>
    call('GET', `/pipeline?brandId=${brandIn.id}`, bm),
  ),
);
results.push(
  await scenario('Report summary (month, brand)', Math.min(N, 200), Math.min(C, 10), () =>
    call('GET', `/reports/summary?from=${from}&to=${to}`, bm),
  ),
);
results.push(
  await scenario('Report by executive (month)', Math.min(N, 200), Math.min(C, 10), () =>
    call('GET', `/reports/breakdown?from=${from}&to=${to}&by=executive`, bm),
  ),
);
results.push(
  await scenario('My dashboard (executive)', Math.min(N, 300), Math.min(C, 20), (k) =>
    call('GET', `/reports/summary?from=${from}&to=${to}&mine=true`, exec(k)),
  ),
);
const run = Date.now() % 1_000_000;
results.push(
  await scenario('Lead intake (new enquiries)', Math.min(N, 500), Math.min(C, 20), async (k) => {
    const t0 = performance.now();
    const res = await fetch(`${API}/intake/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        name: `[LOAD] Intake B${run}-${k}`,
        phone: `+91 5${String(run).padStart(6, '0')}${String(k).padStart(3, '0')}`,
      }),
    });
    await res.text();
    return { ms: performance.now() - t0, status: res.status };
  }),
);
if (process.env.CRON_SECRET) {
  const t0 = performance.now();
  let ticks = 0;
  let jobs = 0;
  for (;;) {
    const r = await fetch(`${API}/internal/tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const b = await r.json();
    ticks++;
    jobs += b.jobs?.claimed ?? 0;
    if (!b.jobs?.claimed || ticks > 50) break;
  }
  console.log(
    `Job queue drained: ${jobs} jobs in ${ticks} ticks, ${Math.round(performance.now() - t0)} ms`,
  );
  results.push({ action: 'Job queue drain', jobs, ticks, ms: Math.round(performance.now() - t0) });
}
console.log(JSON.stringify(results));

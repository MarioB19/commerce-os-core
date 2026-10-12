import {evidencePath} from '../support/test-evidence-path.js';
import {fixtureRequest,useSimulationFixtureTransport} from "./support/simulation-fixture-transport.js";
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { prepareRateBudget } from './support/rate-budget.js';
import {evidencePath} from '../support/evidence.js';
test.beforeEach(async ({page}) => { await useSimulationFixtureTransport(page); });
test.beforeEach(async ({ request }, info) => { await prepareRateBudget(request, info); });

test('production inbox durable → visible latency with foreground polling', async ({ page, request }) => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const login = await fixtureRequest(page).post('/api/auth/sign-in/email', {
      data:{email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD},
      headers:{Origin:process.env.E2E_BASE_URL??'http://127.0.0.1:5173'},
    });
    expect(login.status()).toBe(200);
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: /Todo conectado/ })).toBeVisible();
    const res = await fixtureRequest(page).post('/v1/channel-accounts', {
      headers: { 'Idempotency-Key': randomUUID(), Origin: process.env.E2E_BASE_URL??'http://127.0.0.1:5173' },
      data: { environment: 'SIMULATION', name: 'Medición local '+randomUUID().slice(0,6), provider: 'simulator' },
    });
    expect(res.ok()).toBeTruthy();
    const account = (await res.json()).data;
    const identity = 'lid:latency-'+randomUUID();
    const ingest = (text:string) => request.post(`http://127.0.0.1:${process.env.INGRESS_PORT??3002}/webhooks/simulator/${process.env.WORKSPACE_ID}/${account.id}`, {
      headers: { Authorization: `Bearer ${process.env.SIMULATOR_INGRESS_TOKEN}` }, data: { id: randomUUID(), identity, text },
    });
    expect((await ingest('Inicio de medición sintética')).ok()).toBeTruthy();
    let conversation:string|undefined;
    await expect.poll(async()=>{
      const r=await fixtureRequest(page).get('/v1/conversations?environment=SIMULATION&account_id='+account.id);
      conversation=(await r.json()).data[0]?.id;return conversation;
    }).toBeTruthy();
    await page.goto('/sales/inbox?conversation='+conversation);
    await expect(page.locator('.chat-body').getByText('Inicio de medición sintética',{exact:true})).toBeVisible();
    const samples:number[]=[];
    // Deterministic phase offsets prevent an artificially aligned polling measurement.
    for(let n=0;n<30;n++){
      await page.waitForTimeout((n*137)%600);
      const marker='Latencia sintética '+n+' '+randomUUID().slice(0,8);
      expect((await ingest(marker)).ok()).toBeTruthy();
      const received=(await db.query('SELECT received_at FROM inbound_envelopes WHERE account_id=$1 ORDER BY received_at DESC LIMIT 1',[account.id])).rows[0].received_at;
      await expect(page.locator('.chat-body').getByText(marker,{exact:true})).toBeVisible();
      samples.push(Date.now()-new Date(received).getTime());
    }
    const sorted=[...samples].sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1]!;
    const evidence={measured_at:new Date().toISOString(),build:'production Vite preview + bundled independent Node services',database:'PostgreSQL 17 local Docker',transport:'authenticated simulator HTTP; no real WhatsApp session',profile:{samples:30,active_browser_tabs:1,foreground_polling_ms:1000,concurrent_load:'separate load profile; not simultaneous'},metric:'durable received_at in PostgreSQL → rendered exact message text; same host clocks',samples_ms:samples,p50_ms:sorted[14],p95_ms:p95,max_ms:sorted.at(-1),target_p95_ms:2000,passed:p95<=2000,limits:'Local host measurement; excludes WAN and real gateway latency; no production SLO claim.'};
    writeFileSync(evidencePath('ui-latency.json'),JSON.stringify(evidence,null,2)+'\n');
    expect(p95,'Foreground inbox p95 durable→visible target').toBeLessThanOrEqual(2000);
  } finally { await db.end(); }
});

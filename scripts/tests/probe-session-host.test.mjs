import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeSessionHost} from '../probe-session-host.mjs';
test('independent host probe distinguishes readiness from outage without claiming session authentication',async()=>{
 assert.equal((await probeSessionHost('https://example.invalid',async()=>Response.json({status:'ready'}))).status,'AVAILABLE');
 assert.equal((await probeSessionHost('https://example.invalid',async()=>Response.json({status:'down'},{status:503}))).status,'UNAVAILABLE');
 const failed=await probeSessionHost('https://example.invalid',async()=>{throw Error('host offline');});assert.equal(failed.status,'UNREACHABLE');assert.equal(failed.notification_delivery,'NOT_CONFIGURED');assert.equal(failed.session_authentication,'NOT_OBSERVED');
});

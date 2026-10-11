import {describe,it,expect,vi} from 'vitest';

// The status projection is pure; authentication is irrelevant to these tests.
vi.mock('../../apps/api/src/auth.js',()=>({auth:{},trustedOrigins:[],provisionUser:vi.fn()}));
import {defaultOperationalSettings} from '../../packages/contracts/src/index.js';
import {configuredSystemStatus} from '../../apps/api/src/system.js';

describe('Operator-declared system installation status',()=>{
 it('does not infer deployment or monitoring from a production process or hostname',()=>{
  const status=configuredSystemStatus({NODE_ENV:'production',BETTER_AUTH_URL:'https://commerce.example.invalid'});
  expect(status.deployment).toMatchObject({status:'UNKNOWN',production_modified:null});
  expect(status.external_monitor).toMatchObject({status:'UNKNOWN',installed:null,verified:null,current_health:'NOT_OBSERVED'});
 });
 it('distinguishes prepared, deploying and deployed facts without changing dispatch permissions',()=>{
  const prepared=configuredSystemStatus({COMMERCE_DEPLOYMENT_STATUS:'PREPARED',DISPATCH_FROZEN:'true'});
  const deploying=configuredSystemStatus({COMMERCE_DEPLOYMENT_STATUS:'DEPLOYING',DISPATCH_FROZEN:'true'});
  const deployed=configuredSystemStatus({COMMERCE_DEPLOYMENT_STATUS:'DEPLOYED',DISPATCH_FROZEN:'true'});
  expect(prepared.deployment).toMatchObject({status:'PREPARED',production_modified:false});
  expect(deploying.deployment).toMatchObject({status:'DEPLOYING',production_modified:true});
  expect(deployed.deployment).toMatchObject({status:'DEPLOYED',production_modified:true});
  expect([prepared,deploying,deployed].every(status=>status.dispatch_frozen)).toBe(true);
 });
 it('keeps monitor installation, verification and current health separate',()=>{
  expect(configuredSystemStatus({COMMERCE_EXTERNAL_MONITOR_STATUS:'NOT_INSTALLED'}).external_monitor).toMatchObject({installed:false,verified:false});
  expect(configuredSystemStatus({COMMERCE_EXTERNAL_MONITOR_STATUS:'INSTALLED'}).external_monitor).toMatchObject({installed:true,verified:false});
  expect(configuredSystemStatus({COMMERCE_EXTERNAL_MONITOR_STATUS:'VERIFIED'}).external_monitor).toMatchObject({installed:true,verified:true,current_health:'NOT_OBSERVED'});
 });
 it('reports unknown for invalid declarations instead of echoing arbitrary values',()=>{
  const status=configuredSystemStatus({COMMERCE_DEPLOYMENT_STATUS:'typo',COMMERCE_EXTERNAL_MONITOR_STATUS:'true'});
  expect(status.deployment.status).toBe('UNKNOWN');
  expect(status.deployment.production_modified).toBeNull();
  expect(status.external_monitor.installed).toBeNull();
  expect(status.external_monitor.verified).toBeNull();
 });
 it('uses persisted policy rather than obsolete process flags and preserves the global workspace pause',()=>{
  const enabled={...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true};
  expect(configuredSystemStatus({DISPATCH_FROZEN:'true'},false,enabled)).toMatchObject({dispatch_frozen:false,dispatch_frozen_sources:{operational_policy:false,workspace_control:false,workspace_control_scope:'ALL_ENVIRONMENTS'}});
  expect(configuredSystemStatus({DISPATCH_FROZEN:'false'},true,enabled).dispatch_frozen).toBe(true);
  expect(configuredSystemStatus({DISPATCH_FROZEN:'false'},false).dispatch_frozen).toBe(true);
 });
});

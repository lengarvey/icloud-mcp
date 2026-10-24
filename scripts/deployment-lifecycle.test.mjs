import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploy} from './deploy-production.mjs';
import {lifecycle} from './deployment-fixture.mjs';
test('failed stateless health restores prior version',async()=>{const h=lifecycle();await assert.rejects(deploy({...h,health:h.failHealth}),/STATELESS_ROLLBACK_VERIFIED/);assert.equal(h.active,'old');assert.equal(h.mutations.length,3);});
test('stateful health failure never rolls back OAuth state',async()=>{const h=lifecycle({stateful:true});await assert.rejects(deploy({...h,health:h.failHealth}),/STATEFUL_HEALTH_FAILED_NO_ROLLBACK/);assert.equal(h.active,'new');assert.equal(h.mutations.length,2);});
test('settings drift prevents rollback',async()=>{const h=lifecycle({drift:true});await assert.rejects(deploy({...h,health:h.failHealth}),/Rollback withheld/);assert.equal(h.active,'new');assert.equal(h.mutations.length,2);});
test('zero-binding unactivated candidate safely reconciles with a new upload',async()=>{const h=lifecycle({staged:true});await deploy(h);assert.equal(h.active,'new');});
test('stateful unactivated candidate fails before mutation',async()=>{const h=lifecycle({staged:true,stateful:true});await assert.rejects(deploy(h),/reconciliation requires review/);assert.equal(h.mutations.length,0);});
test('unexpected hostname prevents mutation',async()=>{const h=lifecycle();await assert.rejects(deploy({...h,expectedHostname:'wrong.invalid'}),/Unexpected production hostname/);assert.equal(h.mutations.length,0);});
test('health verifier is mandatory before upload',async()=>{const h=lifecycle();await assert.rejects(deploy({...h,health:undefined}),/health verifier is required/);assert.equal(h.mutations.length,0);});

test('intervening activation prevents automatic rollback',async()=>{const h=lifecycle();let changed=false;const api=async(p,o)=>p==='/deployments'&&!o&&changed?[{versions:[{version_id:'other',percentage:100}]}]:h.api(p,o);await assert.rejects(deploy({...h,api,health:async()=>{changed=true;throw new Error();}}),/Rollback withheld/);assert.equal(h.mutations.length,2);});
test('uncertain activation is never blindly retried',async()=>{const h=lifecycle();let writes=0;const api=async(p,o)=>{if(p==='/deployments'&&o?.method==='POST'){writes++;throw new Error('uncertain');}return h.api(p,o);};await assert.rejects(deploy({...h,api}),/uncertain/);assert.equal(writes,1);});
test('deployment change during healthy probes is not reported as verified',async()=>{const h=lifecycle();let changed=false;const api=async(p,o)=>p==='/deployments'&&!o&&changed?[{versions:[{version_id:'other',percentage:100}]}]:h.api(p,o);await assert.rejects(deploy({...h,api,health:async()=>{changed=true;}}),/changed during public health/);});

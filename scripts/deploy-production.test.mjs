import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeVersion,uploadMetadata,verifyStaged,deploy,makeApi,mainGuard,preservedExports,knownRejectedCandidate} from './deploy-production.mjs';
const sha='a'.repeat(40);
const initial={id:'old',resources:{bindings:[{name:'SECRET',type:'secret_text'},{name:'OWNER',type:'plain_text',text:'private-owner'}],script_runtime:{compatibility_date:'2026-08-01',compatibility_flags:['nodejs_compat'],usage_model:'standard'}}};
const old=[{id:'deploy-old',versions:[{version_id:'old',percentage:100}]}];
function harness(change={}) {
 let uploaded=false,activated=false;const calls=[];
 const api=async(path,options={})=>{
  calls.push({path,method:options.method||'GET'});
  if(path==='/deployments'&&options.method==='POST'){activated=true;return {id:'deployed'};}
  if(path==='/versions?bindings_inherit=strict'&&options.method==='POST'){uploaded=true;const meta=JSON.parse(await options.body.get('metadata').text());assert.equal(meta.bindings[1].type,'inherit');assert(!JSON.stringify(meta).includes('private-owner'));return {id:'new'};}
  if(path==='/deployments')return {deployments:activated?[{versions:[{version_id:'new',percentage:100}]}]:old};
  if(path==='/versions')return {items:[{id:uploaded?'new':change.latest||'old'}]};
  if(path==='/versions/unknown')return {...initial,id:'unknown'};
  if(path==='/versions/old')return initial;
  if(path==='/versions/new')return change.staged||{...initial,id:'new'};
  if(path==='/settings')return {bindings:initial.resources.bindings,compatibility_date:'2026-08-01'};
  if(path.startsWith('/workers/domains'))return [{service:'icloud-mcp',enabled:true,hostname:'test.example.net',previews_enabled:false}];
  throw new Error(path);
 };
 return {api,calls,health:async()=>{},assertCurrentMain:async()=>{},build:async()=>Buffer.from('bundled'),get activated(){return activated;}};
}
test('refuses split or empty deployments',()=>{assert.throws(()=>activeVersion([]));assert.throws(()=>activeVersion([{versions:[{version_id:'a',percentage:50},{version_id:'b',percentage:50}]}]));});
test('metadata inherits all bindings without serializing their values',()=>{const m=uploadMetadata(initial,sha);assert.deepEqual(m.bindings,[{name:'SECRET',type:'inherit'},{name:'OWNER',type:'inherit'}]);assert(!JSON.stringify(m).includes('private-owner'));});
test('rejects configuration or runtime differences',()=>{assert.throws(()=>verifyStaged(initial,{resources:{...initial.resources,bindings:[]}}));assert.throws(()=>verifyStaged(initial,{resources:{...initial.resources,script_runtime:{}}}));});
test('successful upload verifies configuration before activation',async()=>{const h=harness();const r=await deploy({...h,sha});assert.equal(r.versionId,'new');assert(h.calls.findIndex(c=>c.path==='/versions/new')<h.calls.findIndex(c=>c.path==='/deployments'&&c.method==='POST'));});
test('unreviewed latest upload blocks every mutation',async()=>{const h=harness({latest:'unknown'});await assert.rejects(deploy({...h,sha}),/Unactivated version/);assert(h.calls.every(c=>c.method==='GET'));});
test('binding drift leaves production untouched',async()=>{const h=harness({staged:{resources:{...initial.resources,bindings:[]}}});await assert.rejects(deploy({...h,sha}),/bindings differ/);assert(!h.activated);});
test('build failure leaves production untouched',async()=>{const h=harness();await assert.rejects(deploy({...h,sha,build:async()=>{throw new Error('bad build')}}),/bad build/);assert(h.calls.every(c=>c.method==='GET'));});
test('API errors never echo provider payload or credentials',async()=>{const api=makeApi({token:'sensitive-token',account:'account',worker:'worker',fetchImpl:async()=>({ok:false,status:403,json:async()=>({success:false,errors:[{message:'sensitive-token private-owner'}]})})});await assert.rejects(api('/settings'),e=>!e.message.includes('sensitive-token')&&!e.message.includes('private-owner'));});

test('supports existing workers with zero bindings',()=>{assert.deepEqual(uploadMetadata({resources:{...initial.resources,bindings:[]}},sha).bindings,[]);});
test('main guard rejects stale SHA and withholds API bodies',async()=>{const guard=mainGuard({repository:'owner/repo',token:'secret',sha,fetchImpl:async()=>({ok:true,json:async()=>({object:{sha:'b'.repeat(40)}})})});await assert.rejects(guard(),/no longer main/);});
test('main guard required before any remote request',async()=>{const h=harness();await assert.rejects(deploy({...h,sha,assertCurrentMain:undefined}),/guard is required/);assert.equal(h.calls.length,0);});
test('stale main before upload prevents mutations',async()=>{const h=harness();let calls=0;await assert.rejects(deploy({...h,sha,assertCurrentMain:async()=>{if(++calls===2)throw new Error('stale');}}),/stale/);assert(h.calls.every(c=>c.method==='GET'));});
test('stale main after upload prevents activation',async()=>{const h=harness();let calls=0;await assert.rejects(deploy({...h,sha,assertCurrentMain:async()=>{if(++calls===3)throw new Error('stale');}}),/stale/);assert(!h.activated);});

test('accepts Cloudflare deployments envelope and fails closed on malformed result',()=>{assert.equal(activeVersion({deployments:old}),'old');assert.throws(()=>activeVersion({}));assert.throws(()=>activeVersion({deployments:[]}));});

test('preserves live Durable Object export declarations without lifecycle changes',()=>{
 const exports={UserAgent:{type:'durable-object',storage:'sqlite'}};
 assert.deepEqual(uploadMetadata({resources:{...initial.resources,script_runtime:{...initial.resources.script_runtime,exports}}},sha).exports,exports);
 for(const bad of [{UserAgent:{type:'durable-object',storage:'sqlite',state:'deleted'}},{UserAgent:{type:'durable-object',storage:'sqlite',renamed_to:'Other'}},{Admin:{type:'worker'}},null])assert.throws(()=>preservedExports({exports:bad}));
});
test('known staged repair is pinned to exact worker, active version, candidate and recorded commit',()=>{
 const production=structuredClone(initial);production.resources.script_runtime.exports={UserAgent:{type:'durable-object',storage:'sqlite'}};
 const candidate={...structuredClone(initial),id:'f573df63-7c4a-4d46-9529-88accc5ba501',annotations:{'workers/commit_sha':'d82088a723febbd7ed9d01c51465c5622985894b'}};
 const args={worker:'icloud-mcp',active:'0400b0f2-5925-4cd5-9832-055349ea60b7',production,candidate};
 assert.equal(knownRejectedCandidate(args),true);
 for(const changed of [{worker:'other'},{active:'other'},{candidate:{...candidate,id:'other'}},{candidate:{...candidate,annotations:{}}}])assert.equal(knownRejectedCandidate({...args,...changed}),false);
 const changed=structuredClone(candidate);changed.resources.bindings=[];assert.throws(()=>knownRejectedCandidate({...args,candidate:changed}));
 const runtimeChanged=structuredClone(candidate);runtimeChanged.resources.script_runtime.compatibility_date='2026-10-01';assert.throws(()=>knownRejectedCandidate({...args,candidate:runtimeChanged}));
});

test('rejects unsafe export shapes and non-identical known candidate metadata',()=>{
 for(const entry of [{type:'durable-object',storage:'other'},{type:'durable-object',storage:'sqlite',container:'new'},{type:'durable-object',storage:'sqlite',state:'renamed'}])assert.throws(()=>preservedExports({exports:{UserAgent:entry}}));
 const production=structuredClone(initial);production.resources.script_runtime.exports={UserAgent:{type:'durable-object',storage:'sqlite'}};
 const candidate={...structuredClone(initial),id:'f573df63-7c4a-4d46-9529-88accc5ba501',annotations:{'workers/commit_sha':'d82088a723febbd7ed9d01c51465c5622985894b'}};
 const args={worker:'icloud-mcp',active:'0400b0f2-5925-4cd5-9832-055349ea60b7',production,candidate};
 for(const mutate of [c=>c.resources.bindings[0].namespace_id='changed',c=>c.resources.script_runtime.exports={},c=>c.resources.script_runtime.exports={UserAgent:{type:'durable-object',storage:'legacy-kv'}}]){const c=structuredClone(candidate);mutate(c);assert.throws(()=>knownRejectedCandidate({...args,candidate:c}));}
});
test('known repair rechecks the complete candidate before any upload',async()=>{
 const active='0400b0f2-5925-4cd5-9832-055349ea60b7',id='f573df63-7c4a-4d46-9529-88accc5ba501';
 const production=structuredClone(initial);production.id=active;production.resources.script_runtime.exports={UserAgent:{type:'durable-object',storage:'sqlite'}};
 const candidate={...structuredClone(initial),id,annotations:{'workers/commit_sha':'d82088a723febbd7ed9d01c51465c5622985894b'}};
 for(const changed of [false,true]){
  const h=harness();let reads=0;let uploaded=false;let activated=false;
  const api=async(path,options={})=>{
   if(path==='/deployments'&&options.method==='POST'){activated=true;return {};}
   if(path==='/deployments')return {deployments:[{versions:[{version_id:activated?'new':active,percentage:100}]}]};
   if(path==='/versions')return {items:[{id:uploaded?'new':id}]};
   if(path===`/versions/${active}`)return production;
   if(path===`/versions/${id}`){reads++;return changed&&reads===2?{...candidate,annotations:{}}:candidate;}
   if(path==='/versions/new')return {...production,id:'new'};
   if(path==='/versions?bindings_inherit=strict'){uploaded=true;return {id:'new'};}
   return h.api(path,options);
  };
  if(changed){await assert.rejects(deploy({...h,api,sha}),/candidate changed/);assert.equal(uploaded,false);}
  else {assert.equal((await deploy({...h,api,sha})).versionId,'new');assert.equal(reads,2);}
 }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeVersion,uploadMetadata,verifyStaged,deploy,makeApi,mainGuard} from './deploy-production.mjs';
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

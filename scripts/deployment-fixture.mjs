const sha='a'.repeat(40);
export function lifecycle({stateful=false,staged=false,drift=false,hostname='puzzles.btld.cc',worker='little-wins-puzzles'}={}) {
 let active='old', latest=staged?'staged':'old'; const mutations=[];let unhealthy=false;
 const version={resources:{bindings:stateful?[{name:'OAUTH_KV',type:'kv_namespace',namespace_id:'kv'}]:[],script_runtime:{compatibility_date:'2026-10-24',compatibility_flags:[]}}};
 const api=async(path,options={})=>{
  if(options.method==='POST'){mutations.push({path,body:options.body});if(path.startsWith('/versions')){latest='new';return{id:'new'};}active=JSON.parse(options.body).versions[0].version_id;return {};}
  if(path==='/deployments')return [{id:active,versions:[{version_id:active,percentage:100}]}];
  if(path==='/versions')return {items:[{id:latest}]};
  if(path.startsWith('/versions/'))return structuredClone(version);
  if(path==='/settings')return {bindings:version.resources.bindings,tail_consumers:unhealthy&&drift?['changed']:[]};
  if(path.startsWith('/workers/domains'))return [{service:worker,hostname,previews_enabled:false}];
  throw new Error('Unexpected request');
 };
 return {api,sha,worker,health:async()=>{},build:async()=>Buffer.from('bundle'),assertCurrentMain:async()=>{},stateless:!stateful,mutations,failHealth:async()=>{unhealthy=true;throw new Error('private');},get active(){return active;}};
}

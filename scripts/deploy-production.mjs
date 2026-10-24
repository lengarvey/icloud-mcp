// Code-only deployment: production configuration remains owned by Cloudflare.
// Never log API bodies, bindings, credentials, or the generated live config.
import { mcpHealth } from './deployment-health.mjs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(x => JSON.parse(canonical(x))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])));
  return JSON.stringify(value);
}
export class DeploymentOutcomeError extends Error { constructor(code) { super(code); this.code = code; } }
function requireSame(a, b, message) { if (canonical(a) !== canonical(b)) throw new Error(message); }
export function activeVersion(deployments) {
  const entries = Array.isArray(deployments) ? deployments : deployments?.deployments;
  const current = entries?.[0];
  if (current?.versions?.length !== 1 || current.versions[0].percentage !== 100) throw new Error('Expected one production version serving 100%; refusing a split rollout.');
  return current.versions[0].version_id;
}
export function preservedExports(runtime) {
  if (runtime.exports === undefined) return {};
  if (!runtime.exports || typeof runtime.exports !== 'object' || Array.isArray(runtime.exports)) throw new Error('Invalid existing exports.');
  for (const [name, entry] of Object.entries(runtime.exports)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || entry?.type !== 'durable-object' || !['sqlite','legacy-kv'].includes(entry.storage) ||
        Object.keys(entry).some(k => !['type','storage','state'].includes(k)) || (entry.state !== undefined && entry.state !== 'created')) {
      throw new Error('Unsupported existing export lifecycle; manual review required.');
    }
  }
  return {exports: structuredClone(runtime.exports)};
}
export function uploadMetadata(version, sha) {
  const runtime = version.resources?.script_runtime;
  const bindings = version.resources?.bindings;
  if (!runtime?.compatibility_date || !Array.isArray(bindings)) throw new Error('Production metadata incomplete.');
  if (new Set(bindings.map(x => x.name)).size !== bindings.length || bindings.some(x => !x.name)) throw new Error('Invalid production binding names.');
  return {
    main_module: 'index.js',
    ...preservedExports(runtime),
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags || [],
    usage_model: runtime.usage_model,
    bindings: bindings.map(({name}) => ({name, type: 'inherit'})),
    annotations: {'workers/commit_sha': sha, 'workers/message': `GitHub main ${sha}`},
  };
}
export function verifyStaged(before, after) {
  const sorted = v => [...v.resources.bindings].sort((a,b) => a.name.localeCompare(b.name));
  requireSame(sorted(before), sorted(after), 'Staged bindings differ from production; not activating.');
  requireSame(before.resources.script_runtime, after.resources.script_runtime, 'Staged runtime differs from production; not activating.');
}
export function makeApi({ token, account, worker, fetchImpl = fetch }) {
  const root = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  return async (suffix, options = {}) => {
    const url = suffix.startsWith('/workers/') ? root + suffix : root + `/workers/scripts/${worker}` + suffix;
    let response;
    try { response = await fetchImpl(url, {...options, headers: {...options.headers, Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(60000)}); }
    catch { throw new Error('Cloudflare request failed or timed out; check remote deployment state before retrying.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Cloudflare returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok || !data.success) throw new Error(`Cloudflare request failed (HTTP ${response.status}); response body withheld to protect private settings.`);
    return data.result;
  };
}
export async function deploy({api, build, sha, assertCurrentMain, health, stateless = false, expectedHostname, worker = 'icloud-mcp'}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full Git commit SHA is required.');
  if (typeof assertCurrentMain !== 'function') throw new Error('Main-branch freshness guard is required.');
  await assertCurrentMain();
  const deployments = await api('/deployments');
  const active = activeVersion(deployments);
  const latest = await api('/versions');
  const version = await api(`/versions/${active}`);
  if (stateless && version.resources?.bindings?.length !== 0) throw new Error('Stateless deployment requires zero production bindings.');
  const inheritanceSource = latest.items?.[0]?.id;
  if (!inheritanceSource) throw new Error('Latest version unavailable.');
  if (inheritanceSource !== active) {
    // Only zero-binding workers can safely ignore an unactivated upload: no
    // secret or data-binding state can be inherited from that candidate.
    if (!stateless) throw new Error('Unactivated version found: stateful reconciliation requires review; no mutations performed.');
    verifyStaged(version, await api(`/versions/${inheritanceSource}`));
  }
  const settings = await api('/settings');
  const domains = await api(`/workers/domains?service=${encodeURIComponent(worker)}`);
  const liveDomains = domains.filter(d => d.service === worker && d.enabled !== false);
  if (liveDomains.length !== 1 || liveDomains[0].previews_enabled) throw new Error('Expected exactly one production custom domain with previews disabled.');
  const hostname = liveDomains[0].hostname;
  if (expectedHostname && hostname !== expectedHostname) throw new Error('Unexpected production hostname.');
  if (typeof health !== 'function') throw new Error('Public health verifier is required.');
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.endsWith('.example.com')) throw new Error('Invalid production hostname.');
  const metadata = uploadMetadata(version, sha);
  const bundle = await build({hostname, runtime: version.resources.script_runtime, worker});
  // Recheck immediately before inheriting: Cloudflare inherits from latest upload.
  requireSame((await api('/versions')).items?.[0]?.id, inheritanceSource, 'Latest version changed during build.');
  requireSame(await api('/deployments'), deployments, 'Production deployment changed during build.');
  requireSame(await api('/settings'), settings, 'Production settings changed during build.');
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  form.append('index.js', new Blob([bundle], {type:'application/javascript+module'}), 'index.js');
  // Mutations deliberately have no automatic retries: outcomes can be uncertain.
  await assertCurrentMain();
  const uploaded = await api('/versions?bindings_inherit=strict', {method:'POST', body: form});
  if (!uploaded.id) throw new Error('Upload returned no version ID; inspect remote state.');
  verifyStaged(version, await api(`/versions/${uploaded.id}`));
  requireSame(await api('/deployments'), deployments, 'Production deployment changed after upload.');
  const newSettings = await api('/settings');
  const withoutAnnotations = ({annotations, ...rest}) => rest;
  requireSame(withoutAnnotations(newSettings), withoutAnnotations(settings), 'Production settings changed after upload.');
  requireSame(await api(`/workers/domains?service=${encodeURIComponent(worker)}`), domains, 'Custom domains changed after upload.');
  requireSame((await api('/versions')).items?.[0]?.id, uploaded.id, 'Another version was uploaded concurrently.');
  await assertCurrentMain();
  await api('/deployments', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({strategy:'percentage', versions:[{version_id:uploaded.id,percentage:100}], annotations:{'workers/message':`GitHub main ${sha}`}})});
  if (activeVersion(await api('/deployments')) !== uploaded.id) throw new Error('Activation could not be verified; inspect remote state.');
  try { await health({hostname}); } catch {
    // MCP code may already have written OAuth/KV state. A version rollback
    // cannot undo that data and may make it incompatible with older code.
    if (!stateless) throw new DeploymentOutcomeError('STATEFUL_HEALTH_FAILED_NO_ROLLBACK');
    // Stateless rollback only: do not overwrite an intervening deployment,
    // settings change, domain change, or upload by another writer.
    const current = await api('/deployments');
    if (activeVersion(current) !== uploaded.id) throw new Error('Health failed; deployment changed. Rollback withheld.');
    requireSame((await api('/versions')).items?.[0]?.id, uploaded.id, 'Health failed; concurrent upload. Rollback withheld.');
    requireSame(withoutAnnotations(await api('/settings')), withoutAnnotations(settings), 'Health failed; settings changed. Rollback withheld.');
    requireSame(await api(`/workers/domains?service=${encodeURIComponent(worker)}`), domains, 'Health failed; domains changed. Rollback withheld.');
    verifyStaged(version, await api(`/versions/${active}`));
    requireSame(await api('/deployments'), current, 'Health failed; deployment changed before rollback.');
    await api('/deployments', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({strategy:'percentage',versions:[{version_id:active,percentage:100}],annotations:{'workers/message':`CI health rollback ${sha}`}})});
    if (activeVersion(await api('/deployments')) !== active) throw new Error('Rollback outcome unverified; inspect remote state.');
    throw new DeploymentOutcomeError('STATELESS_ROLLBACK_VERIFIED');
  }
  if (activeVersion(await api('/deployments')) !== uploaded.id) throw new Error('Deployment changed during public health verification.');
  requireSame(withoutAnnotations(await api('/settings')), withoutAnnotations(settings), 'Settings changed during public health verification.');
  return {versionId:uploaded.id, previousVersionId:active, hostname};
}
export async function buildBundle({hostname, runtime, worker}, root = process.cwd()) {
  const configPath = resolve(root, '.wrangler/production-ci-bundle/build-config.json');
  const generatedPath = resolve(root, 'src/deployed-hostname.generated.ts');
  const output = resolve(root, '.wrangler/production-ci-bundle');
  const saved = new Map();
  for (const path of [generatedPath]) {
    try { saved.set(path, await readFile(path)); } catch (e) { if (e.code !== 'ENOENT') throw e; saved.set(path,null); }
  }
  try {
    await rm(output,{recursive:true,force:true}); await mkdir(output,{recursive:true});
    const config = {name:worker,main:resolve(root,'src/index.ts'),compatibility_date:runtime.compatibility_date,compatibility_flags:runtime.compatibility_flags||[],workers_dev:false,preview_urls:false,routes:[{pattern:hostname,custom_domain:true}]};
    await writeFile(configPath, JSON.stringify(config), {mode:0o600});
    await writeFile(generatedPath, `// Generated for production CI; do not commit.\nexport const DEPLOYED_HOSTNAME = ${JSON.stringify(hostname)};\n`, {mode:0o600});
    const childEnv = {...process.env, WRANGLER_SEND_METRICS:'false', XDG_CONFIG_HOME:resolve(output,'config'), WRANGLER_LOG_PATH:resolve(output,'wrangler.log')};
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) delete childEnv[key];
    const result = spawnSync(resolve(root,'node_modules/.bin/wrangler'), ['deploy','--config',configPath,'--dry-run','--outdir',output], {cwd:root, env:childEnv, encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
    if (result.status !== 0) throw new Error('Production bundle failed; build output withheld to protect configuration.');
    const bundle = await readFile(resolve(output,'index.js'));
    if (!bundle.includes(Buffer.from(hostname))) throw new Error('Production hostname missing from bundle.');
    return bundle;
  } finally {
    for (const [path, bytes] of saved) { if (bytes === null) await rm(path,{force:true}); else await writeFile(path,bytes); }
    await rm(output,{recursive:true,force:true});
  }
}
// Fail closed if HEAD cannot be established. Do not emit private API responses.
export function mainGuard({repository, token, sha, fetchImpl = fetch}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) throw new Error('GitHub freshness guard is not configured.');
  return async () => {
    let response, data;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error();
      data = await response.json();
    } catch { throw new Error('Could not verify current main HEAD; refusing deployment.'); }
    if (data.object?.sha !== sha) throw new Error('This commit is no longer main HEAD; refusing stale deployment.');
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,GITHUB_SHA:sha,GITHUB_REF:ref,GITHUB_EVENT_NAME:event} = process.env;
    if (ref !== 'refs/heads/main' || event !== 'push') throw new Error('Production deployment only runs for a push to main.');
    if (!token || !/^[a-f0-9]{32}$/.test(account||'')) throw new Error('Cloudflare deployment credential/account are not configured.');
    const result = await deploy({api:makeApi({token,account,worker:'icloud-mcp'}),build:buildBundle,sha,health:mcpHealth,assertCurrentMain:mainGuard({repository:process.env.GITHUB_REPOSITORY,token:process.env.GITHUB_TOKEN,sha})});
    console.log(`Verified production version ${result.versionId}.`);
  } catch(e) { console.error(e instanceof DeploymentOutcomeError ? e.code : 'Production deployment failed; no provider payload or configuration was logged. Inspect deployment state before retrying.'); process.exitCode=1; }
}

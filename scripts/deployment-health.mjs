import {createHash} from 'node:crypto';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function boundedHealth(probe, {attempts = 3, sleep = pause} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Invalid health retry bound.');
  for (let i = 0; i < attempts; i++) {
    try { await probe(); return; } catch { if (i + 1 < attempts) await sleep(2000); }
  }
  throw new Error('Public health checks failed; response details withheld.');
}
async function request(fetchImpl, url, options = {}) {
  return fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(10000)});
}
export function mcpHealth({hostname, fetchImpl = fetch, sleep}) {
  return boundedHealth(async () => {
    for (const authorization of [undefined, 'Bearer invalid-ci-health-token']) {
      const headers = {'Content-Type':'application/json', Accept:'application/json, text/event-stream', 'Mcp-Method':'tools/list'};
      if (authorization) headers.Authorization = authorization;
      const response = await request(fetchImpl, `https://${hostname}/mcp`, {method:'POST', headers,
        body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
      const ok = response.status === 401 && /^Bearer\b/i.test(response.headers.get('www-authenticate') || '');
      await response.body?.cancel();
      if (!ok) throw new Error('Authentication gate failed.');
    }
  }, {sleep});
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function puzzlesHealth({hostname, assets, fetchImpl = fetch, sleep}) {
  return boundedHealth(async () => {
    for (const [path, expected] of Object.entries(assets)) {
      const response = await request(fetchImpl, `https://${hostname}${path}`, {headers:{'Cache-Control':'no-cache'}});
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('Asset missing.'); }
      // Bound body consumption, including a malicious or broken streaming response.
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error('Asset too large.'); chunks.push(value); }
      } finally { await reader.cancel(); }
      if (digest(Buffer.concat(chunks)) !== digest(expected)) throw new Error('Asset hash mismatch.');
    }
  }, {sleep});
}

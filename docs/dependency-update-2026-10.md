# Dependency update validation — October 2026

## Scope and versions

Prepared from `b1544dee4a5cb1534931fac08c46d4a80fc0fd72` in an isolated clone. Production configuration, secret bindings, owner allowlist, credential exclusions, indexing default, confirmation and archive behavior are unchanged. Tests use the sanitized template, fake credentials, in-memory transports and disposable Workers storage; remote bindings are disabled.

| Dependency | Before | Selected |
| --- | --- | --- |
| workers-oauth-provider | 0.10.3 | 1.2.4 |
| MCP server | 2.0.0 | 2.3.1 |
| agents | 0.20.1 | 0.30.1 |
| postal-mime | 3.0.0 | 3.0.1 |
| tsdav | 2.3.4 | 2.5.0 |
| unpdf | 1.8.0 | 1.9.1 |
| zod | 4.4.3 | 4.6.7 |
| Wrangler | 4.122.0 | 4.152.0 |
| Workers Vitest integration | vitest-pool-workers 0.21.2 | vitest-plugin 1.4.7 |
| Vitest / runner / snapshot | 4.1.10 | 4.1.12 |
| workers-types | 5.20260812.1 | 5.20261023.1 |

MCP 2.3.1 matches Agents' exact supported peer; 2.4.0 is deferred. Vitest stays on supported patched v4, TypeScript on 5.9.3. The deprecated Workers pool was replaced by its maintained successor, whose Wrangler and Miniflare pins match the deploy tool (Miniflare 5.20261019.2-beta, workerd 1.20261019.1). Only the plugin's vulnerable Zod pin is overridden to the same patched 4.6.7 used by the application; remove the override when upstream adopts a patched version.

Postal MIME 4.1.4 was tested and rejected: it prefers a lossy plain filename parameter over the RFC 2231 UTF-8 parameter, failing the existing Unicode attachment roundtrip. 3.0.1 preserves that behavior and includes linear-time parsing fixes. Newer v4 parsing improvements remain deferred. The legacy OAuth alias is dev-only, used to issue genuine 0.10.3 records for repeatable migration tests, and is not in the Worker bundle.

## Required migrations and security fix

- OAuth 1.x requires a canonical resource even for store-only helpers. All helpers use the same generated hostname and `/mcp`. Obsolete implicit/plain-PKCE switches were removed; tests verify those modes return an error without credentials. No KV migration or lifetime change is required.
- MCP 2.3.1 enforces modern header/body agreement. The internal autonomy client now sends the protocol-version header alongside method and name. Test fixtures follow the same protocol; new negative tests retain strict server validation. Legacy client compatibility remains covered.
- tsdav 2.5 preserves the vCard terminating CRLF. The raw-byte expectation was updated; existing patch tests still verify one terminator. Its diagnostic response is now capped locally before name parsing, with explicit truncation and boundary tests.
- Review reproduced a pre-existing credential routing gap in DAV discovery. The common transport now checks every destination before reading credentials: HTTPS, standard port, exact CalDAV/Contacts service or numeric partition hosts only, no URL credentials/fragment. Redirects remain manual. Mocked tests prove refusal before fetch and before credential access.

## Validation

Baseline: 116 test files, 6,360 tests passed. Updated local suite: 117 test files, 6,390 tests passed. Terminal CI results and exact tested commit are recorded in the PR.

Checks: clean locked installation, TypeScript, full Workers/static suite, secret-file tests, forbidden-token/credential-file scans, tool documentation check, npm dependency tree, and local Wrangler dry-run bundle. No live mailbox operations or credentials were used. Tests cover OAuth/grant migration, interleaved identities, attachments, IMAP, DAV discovery/containment, recall-disabled behavior, confirmations and resumable bulk archive semantics.

Official npm audit before: 19 affected dependency entries (1 critical, 13 high, 5 moderate). Production-only baseline: 12 affected entries. After: zero, both full tree and production-only. Counts include propagated entries, not unique vulnerabilities. Relevant advisories include MCP session isolation/authentication/resource exhaustion and Zod constrained-collection exhaustion; the lockfile also removes affected tooling dependencies. A clean audit is not a claim that dependencies are vulnerability-free.

The new GitHub workflow has read-only repository permissions, pinned official Actions, no secrets and no deployment. It installs the template configuration and runs the same checks, with `wrangler deploy --dry-run` only. Before pushing, GitHub had no deploy workflow/webhook and the Worker had no Cloudflare Builds triggers (successful read-only API response).

## Deployment and rollback — approval required

No merge, preview, upload or production deployment is part of this PR. Before approving deployment:

1. Check the exact PR head and all terminal CI results, and recheck that the intended target remains `icloud-mcp` at `icloud.bttldup.link/mcp`.
2. Use the owner's existing gitignored production configuration, never the generated template. Verify configuration names and security settings without printing secrets: owner-only seed, existing secret bindings, recall disabled, previews/workers.dev disabled, unchanged canonical hostname and compatibility date. Do not provision resources or rotate credentials for this update.
3. From the approved commit, run `npm ci`, typecheck/tests/scans and a dry-run using that existing configuration. The hostname generator must bake the real production hostname. The template-built test bundle must not be deployed.
4. After explicit approval, deploy with the normal production command. Record the new Worker version/deployment. Run unauthenticated endpoint checks first. Real iCloud socket/TLS behavior cannot be proven by mocked tests: any owner-authorized read-only diagnosis must be a separate post-deploy check, with no mailbox mutation or credential logging.
5. If behavior regresses, restore the previous Worker version using Cloudflare's rollback mechanism and verify active version/endpoint. Do not rebuild the old commit and assume it equals the previous deployed artifact. Retain the existing bindings/configuration. OAuth 1.x needs no bulk KV rewrite, but rollback across token rotation may require a client reconnect; do not delete grants or change permissions automatically.

Read-only baseline reverified during preparation: deployment `9d0847a2-9551-4966-92c3-008f43d20989`, version `4a3245e9-a81f-43ab-98ee-5ad8b1264c32` at 100%, created October 9. This identifies the rollback artifact; it does not establish its exact bundled dependency versions.

Remaining limits: no live iCloud/socket proof; newly introduced Apple DAV hostname formats fail closed; tsdav still allocates/downloads its full response before the diagnostic parser cap; Postal MIME v4 is deferred; plugin Zod override needs maintenance. Existing user-facing confirmation and archive protections remain mandatory.

## Primary references

- https://github.com/cloudflare/workers-oauth-provider/blob/v1.0.0/docs/migration-1.0.md
- https://github.com/cloudflare/workers-oauth-provider/releases/tag/v1.2.4
- https://github.com/cloudflare/agents/releases/tag/agents%400.30.1
- https://github.com/postalsys/postal-mime/releases/tag/v3.0.1
- https://github.com/postalsys/postal-mime/releases/tag/v4.1.4
- https://developers.cloudflare.com/workers/testing/vitest-integration/
- https://github.com/advisories/GHSA-jm63-cq47-j5jp
- https://github.com/advisories/GHSA-46jr-4wx8-v453
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5

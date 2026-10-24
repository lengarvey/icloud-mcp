# Automatic code-only production deployment

Pull requests run validation only. A push to main runs typechecking, secret/source scans, documentation checks, the complete test suite, deployment safety unit tests, a dry build and an npm vulnerability audit. Only a successful main-push validation can start the serialized deployment job.

## One-time configuration

Configure these under repository Settings → Secrets and variables → Actions:

- Repository secret `CLOUDFLARE_API_TOKEN`: a dedicated deployment token.
The existing nonsecret account ID is configured in the workflow; a repository `CLOUDFLARE_ACCOUNT_ID` variable can override it when intentionally moving accounts.

Use the narrowest available Cloudflare permissions. Individual Workers Editor restricted to `icloud-mcp`, plus account Workers Scripts Read for custom-domain discovery, covers the required API operations. If only legacy Workers Scripts Edit is available, it can modify all Workers in the selected account. No DNS/zone edits, KV or R2 data permissions, or account administration are needed. Store the token directly in GitHub secrets, never in this repository or chat.

Repository secrets are not protected by a production environment. Repository writers can change workflow code, so main-only conditions do not isolate secrets from malicious writers. Keep write access trusted. PR jobs receive no deployment token and this workflow has no `pull_request_target` event.

## Configuration and safety

Cloudflare remains the source of truth for production runtime settings, private owner allowlist, resource bindings, secrets and the existing custom domain. The deployer reads metadata, builds for the actual hostname with an isolated temporary config, and uploads code with strict inheritance of all existing binding names. It neither fetches secret values nor commits private live settings. Routes, DNS, resource creation and migrations are not modified.

Before uploading and activating, the deployer verifies that its commit is still main HEAD and that observed production state has not changed. It compares staged bindings/runtime before activation and checks public absent/bogus-token authentication gates after activation. Credentials are restricted to the final step, stripped from the bundler subprocess, and never logged. API mutation calls are not automatically retried on uncertain outcomes.

CI must be the sole production deployment writer. GitHub concurrency does not lock external/manual Cloudflare changes, and GitHub/Cloudflare checks cannot be atomic across services.

If a newer unactivated Worker version already exists, this stateful deployer fails before mutation. Inspect its provenance before retrying; metadata alone cannot prove secret-value identity. Never delete it or reset secrets blindly. A stale-main failure after upload may leave such a candidate. A failed post-deploy health check reports `STATEFUL_HEALTH_FAILED_NO_ROLLBACK`: automatic code rollback cannot undo OAuth/KV writes or prove old/new state compatibility. Investigate the active version and account health rather than assuming an automatic rollback is safe.

The production health probes verify public authentication rejection only. They do not replace authorized account-level read checks or prove every OAuth refresh path.

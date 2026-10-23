// Both provider versions use disposable Workers KV and a fake sign-in proof.
// The legacy alias is a dev dependency and never enters the Worker bundle.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { OAuthProvider as LegacyProvider } from "oauth-provider-legacy";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { withEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { oauthProviderOptions } from "../src/auth/oauth";
import { createLoginHandler } from "../src/auth/login-handler";
import { DEPLOYED_HOSTNAME } from "../src/deployed-hostname.generated";
import type { Env } from "../src/env";
import { entryEnv } from "./fixtures/bound-secrets";
import { LISTED_APPLE_ID, FAKE_APP_PASSWORD } from "./fixtures/worker-with-login-proof";

const ORIGIN = `https://${DEPLOYED_HOSTNAME}`;
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW-gFWFOEjXk";
const CHALLENGE = "90EpwHQr_xi9uDtjYyz5mq9Z4RekugHRqg5ijpXC3FQ";
const options = {
  ...oauthProviderOptions,
  defaultHandler: createLoginHandler(async () => {}),
  apiHandler: { fetch: async () => new Response("authorized") },
};
const legacy = new LegacyProvider<Env>({
  apiRoute: options.apiRoute, apiHandler: options.apiHandler, defaultHandler: options.defaultHandler,
  authorizeEndpoint: options.authorizeEndpoint, tokenEndpoint: options.tokenEndpoint,
  clientRegistrationEndpoint: options.clientRegistrationEndpoint, resourceMetadata: options.resourceMetadata,
  refreshTokenTTL: undefined, clientRegistrationTTL: undefined,
});
const current = new OAuthProvider<Env>(options);
type Provider = Pick<OAuthProvider<Env>, "fetch">;

async function call(provider: Provider, env: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await withEnv(env, () => provider.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx));
  await waitOnExecutionContext(ctx);
  return response as Response;
}
function form(values: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) };
}
async function issueCode(env: Env) {
  const registered = await call(legacy, env, "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "migration-fixture", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "migration" });
  const authorized = await call(legacy, env, "/authorize", form({ apple_id: LISTED_APPLE_ID, app_password: FAKE_APP_PASSWORD, oauth_request: query.toString() }));
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  return { client_id, code };
}
function exchange(provider: Provider, env: Env, client_id: string, code: string) {
  return call(provider, env, "/oauth/token", form({ grant_type: "authorization_code", client_id, code, redirect_uri: CALLBACK, code_verifier: VERIFIER }));
}
function environment(): Env {
  return { ...entryEnv(), LOGIN_IP_LIMITER: { limit: async () => ({ success: true }) }, LOGIN_ID_LIMITER: { limit: async () => ({ success: true }) } };
}

describe("OAuth provider upgrade preserves and confines legacy grants", () => {
  it("redeems a code issued by 0.10.3 after upgrading", async () => {
    const env = environment();
    const { client_id, code } = await issueCode(env);
    const response = await exchange(current, env, client_id, code);
    expect(response.status).toBe(200);
    const { access_token } = await response.json() as { access_token: string };
    const api = await call(current, env, "/mcp", { headers: { authorization: `Bearer ${access_token}` } });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("authorized");
  });

  it("accepts an old bearer, rotates its refresh token, and refuses another resource", async () => {
    const env = environment();
    const { client_id, code } = await issueCode(env);
    const issued = await exchange(legacy, env, client_id, code);
    expect(issued.status).toBe(200);
    const old = await issued.json() as { access_token: string; refresh_token: string };
    expect((await call(current, env, "/mcp", { headers: { authorization: `Bearer ${old.access_token}` } })).status).toBe(200);
    const wrongResource = await call(current, env, "/oauth/token", form({ grant_type: "refresh_token", client_id, refresh_token: old.refresh_token, resource: `${ORIGIN}/other` }));
    expect(wrongResource.status).toBe(400);
    const refreshed = await call(current, env, "/oauth/token", form({ grant_type: "refresh_token", client_id, refresh_token: old.refresh_token, resource: `${ORIGIN}/mcp` }));
    expect(refreshed.status).toBe(200);
    const fresh = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(fresh.refresh_token).not.toBe(old.refresh_token);
    expect((await call(current, env, "/mcp", { headers: { authorization: `Bearer ${fresh.access_token}` } })).status).toBe(200);
    const anotherResource = new OAuthProvider<Env>({ ...options, apiRoute: "/other", resourceMetadata: { resource: `${ORIGIN}/other` } });
    expect((await call(anotherResource, env, "/other", { headers: { authorization: `Bearer ${fresh.access_token}` } })).status).toBe(401);
  });
});

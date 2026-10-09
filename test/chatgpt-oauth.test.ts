// Real provider ceremony, with the existing fake Apple proof. No Apple login.
import { withEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri, signInNotices } from "../src/auth/login-handler";
import { RECALL_NOTICE, RECALL_DISABLED_NOTICE, responseHeadersFor } from "../src/auth/login-page";
import { DEPLOYED_HOSTNAME } from "../src/deployed-hostname.generated";
import type { Env } from "../src/env";
import { entryEnv } from "./fixtures/bound-secrets";
import worker, { FAKE_APP_PASSWORD, LISTED_APPLE_ID } from "./fixtures/worker-with-login-proof";

const STABLE = "https://chatgpt.com/connector_platform_oauth_redirect";
const SPECIFIC = "https://chatgpt.com/connector/oauth/test-callback_id";
const ORIGIN = `https://${DEPLOYED_HOSTNAME}`;
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW-gFWFOEjXk";
const CHALLENGE = "90EpwHQr_xi9uDtjYyz5mq9Z4RekugHRqg5ijpXC3FQ";

function testEnv(callbacks?: string): Env {
  return {
    ...entryEnv(),
    CHATGPT_REDIRECT_URIS: callbacks,
    LOGIN_IP_LIMITER: { limit: async () => ({ success: true }) },
    LOGIN_ID_LIMITER: { limit: async () => ({ success: true }) },
  };
}

async function call(path: string, env: Env, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await withEnv(env, () => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx)) as Response;
  await waitOnExecutionContext(ctx);
  return response;
}

async function register(uri: string, env: Env): Promise<Response> {
  return call("/oauth/register", env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT OAuth test",
      redirect_uris: [uri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

function query(clientId: string, uri: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: uri,
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "chatgpt-test",
  });
}

async function authorize(clientId: string, uri: string, env: Env): Promise<Response> {
  return call("/authorize", env, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": crypto.randomUUID() },
    body: new URLSearchParams({
      apple_id: LISTED_APPLE_ID, app_password: FAKE_APP_PASSWORD,
      oauth_request: query(clientId, uri).toString(),
    }),
  });
}

async function exchange(clientId: string, code: string, uri: string, env: Env, verifier?: string): Promise<Response> {
  return call("/oauth/token", env, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, redirect_uri: uri,
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    }),
  });
}

describe("ChatGPT exact callback policy", () => {
  it("defaults to the stable callback without allowing its entire origin", () => {
    expect(isAllowedRedirectUri(STABLE)).toBe(true);
    for (const uri of ["https://chatgpt.com/", SPECIFIC, `${STABLE}/`, `${STABLE}?next=elsewhere`]) {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    }
  });

  it("allows only configured callback IDs, replacing the stable default", () => {
    const configured = JSON.stringify([SPECIFIC]);
    expect(isAllowedRedirectUri(SPECIFIC, configured)).toBe(true);
    expect(isAllowedRedirectUri(STABLE, configured)).toBe(false);
    expect(isAllowedRedirectUri(`${SPECIFIC}-other`, configured)).toBe(false);
    expect(isAllowedRedirectUri(STABLE, JSON.stringify([SPECIFIC, STABLE]))).toBe(true);
  });

  it.each(["", "[]", "null", "{}", '"*"', '["*"]', "not-json", '[12]', JSON.stringify([STABLE, "https://evil.example/callback"])])("fails closed for an empty or malformed setting: %s", (configured) => {
    expect(isAllowedRedirectUri(STABLE, configured)).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", configured)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:51877/callback", configured)).toBe(true);
  });

  it.each([
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
    "https://evilchatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com:8443/connector_platform_oauth_redirect",
    "https://user:pass@chatgpt.com/connector_platform_oauth_redirect",
    "https://@chatgpt.com/connector_platform_oauth_redirect",
    `${STABLE}#`, `${STABLE}#token`, `${STABLE}?next=https://evil.example`,
    "https://chatgpt.com/connector/oauth/*", "https://chatgpt.com/connector/oauth/../callback",
    "https://user@claude.ai/callback", "https://claude.ai/callback#fragment",
    "http://user@localhost:51877/callback", "http://localhost:51877/callback#fragment",
    "http://localhost.evil.example/callback", "https://localhost/callback", "not a URI",
  ])("rejects unsafe URI even when explicitly configured: %s", (uri) => {
    expect(isAllowedRedirectUri(uri, JSON.stringify([uri]))).toBe(false);
  });

  it("permits form redirects only for a validated callback", () => {
    expect(responseHeadersFor(STABLE)["content-security-policy"]).toContain("form-action 'self' https://chatgpt.com");
    expect(responseHeadersFor("https://chatgpt.com/arbitrary")["content-security-policy"]).not.toContain("https://chatgpt.com");
  });
});

describe("ChatGPT real OAuth provider flow", () => {
  it.each([STABLE, SPECIFIC])("registers, consents and exchanges with S256: %s", async (uri) => {
    const env = testEnv(uri === SPECIFIC ? JSON.stringify([SPECIFIC]) : undefined);
    const registration = await register(uri, env);
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const form = await call(`/authorize?${query(clientId, uri)}`, env);
    expect(form.status).toBe(200);
    expect(form.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com");
    expect(await form.text()).toContain("https://chatgpt.com");
    const consent = await authorize(clientId, uri, env);
    expect(consent.status).toBe(302);
    const destination = new URL(consent.headers.get("location")!);
    expect(`${destination.origin}${destination.pathname}`).toBe(uri);
    expect(destination.searchParams.get("state")).toBe("chatgpt-test");
    const token = await exchange(clientId, destination.searchParams.get("code")!, uri, env, VERIFIER);
    expect(token.status).toBe(200);
    const body = await token.json() as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it("rejects unconfigured callback registration and mismatched registered redirect", async () => {
    const env = testEnv();
    expect((await register(SPECIFIC, env)).status).toBe(400);
    const registration = await register(STABLE, env);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const mismatch = await call(`/authorize?${query(clientId, SPECIFIC)}`, env);
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get("location")).toBeNull();
    const postMismatch = await authorize(clientId, SPECIFIC, env);
    expect(postMismatch.status).toBe(400);
    expect(postMismatch.headers.get("location")).toBeNull();
  });

  it("rejects a different redirect URI at token exchange", async () => {
    const env = testEnv();
    const registration = await register(STABLE, env);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const consent = await authorize(clientId, STABLE, env);
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const response = await exchange(clientId, code, SPECIFIC, env, VERIFIER);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('"access_token"');
  });

  it.each([undefined, "wrong-verifier-value-that-is-long-enough-to-pass-the-length-check"])("rejects a missing or incorrect S256 verifier: %s", async (verifier) => {
    const env = testEnv();
    const registration = await register(STABLE, env);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const consent = await authorize(clientId, STABLE, env);
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const response = await exchange(clientId, code, STABLE, env, verifier);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('"access_token"');
  });
});

describe("recall privacy notice follows explicit opt-in", () => {
  it.each([undefined, "false", "TRUE", "1"])("omits the notice when recall is disabled: %s", (value) => {
    const notices = signInNotices({ ...testEnv(), RECALL_ENABLED: value });
    expect(notices).not.toContain(RECALL_NOTICE);
    expect(notices).toContain(RECALL_DISABLED_NOTICE);
  });
  it("includes the notice when recall is enabled", () => {
    expect(signInNotices({ ...testEnv(), RECALL_ENABLED: "true" })).toContain(RECALL_NOTICE);
  });
});

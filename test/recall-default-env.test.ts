// Real ambient bindings, with no recall config mock and no AI/Vectorize resources.
import { McpServer } from "@modelcontextprotocol/server";
import { env, withEnv } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { LeasedMail } from "../src/agent/lease";
import { createServerFactory } from "../src/mcp/server";
import { recallEnabled } from "../src/recall/config";
import { forgetDeadRef } from "../src/recall/dead-ref";
import { RECALL_DRIVEN, runRecallBackfill, runRecallStep } from "../src/recall/drive";
import { embedder, RecallEmbedError } from "../src/recall/embed";
import { ownerPrincipal } from "./fixtures/bound-secrets";

afterEach(() => vi.restoreAllMocks());

it.each([undefined, "false", "TRUE", "1"])(
  "real ambient config %s neither exposes recall nor touches mail indexing dependencies",
  async (value) => {
    const config = { ...env, RECALL_ENABLED: value, AI: undefined, RECALL_INDEX: undefined };
    const calls = vi.spyOn(McpServer.prototype, "registerTool");
    const grant = vi.fn(async () => "person");
    const mail = { withConnectionLease: vi.fn() } as unknown as LeasedMail;
    const deps = vi.fn(() => { throw new Error("unexpected indexing dependency"); });
    await withEnv(config, async () => {
      expect(recallEnabled()).toBe(false);
      const principal = ownerPrincipal();
      createServerFactory(principal, [], grant)({ era: "modern" } as never);
      const registered = calls.mock.calls as unknown as [string, unknown, Record<symbol, unknown>][];
      expect(registered.map(([name]) => name)).toContain("mail_find");
      expect(registered.map(([name]) => name)).not.toContain("mail_recall");
      expect(registered.map(([name]) => name)).not.toContain("mail_recall_backfill");
      for (const [, , callback] of registered) expect(callback[RECALL_DRIVEN]).toBeUndefined();
      await runRecallStep(principal, mail, grant);
      expect(await runRecallBackfill(await principal, mail, grant, deps)).toEqual({ kind: "refused" });
      await forgetDeadRef(await principal, { mailbox: "INBOX", uidValidity: 1, uid: 1 }, deps);
      expect(() => embedder()).toThrow(RecallEmbedError);
    });
    expect(grant).not.toHaveBeenCalled();
    expect(mail.withConnectionLease).not.toHaveBeenCalled();
    expect(deps).not.toHaveBeenCalled();
  },
);

it("the explicit ambient opt-in exposes the existing recall tools", () => {
  const calls = vi.spyOn(McpServer.prototype, "registerTool");
  withEnv({ ...env, RECALL_ENABLED: "true" }, () => {
    expect(recallEnabled()).toBe(true);
    createServerFactory(ownerPrincipal())({ era: "modern" } as never);
  });
  const names = calls.mock.calls.map(([name]) => name);
  expect(names).toContain("mail_recall");
  expect(names).toContain("mail_recall_backfill");
});

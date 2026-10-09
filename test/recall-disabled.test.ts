import { McpServer } from "@modelcontextprotocol/server";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

// The broad suite explicitly opts in. This file exercises production entry
// points with the gate disabled, while still testing the actual strict parser.
vi.mock("../src/recall/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/recall/config")>();
  return {
    recallEnabled: (config?: { RECALL_ENABLED?: string }) => original.recallEnabled(config ?? {}),
  };
});

import type { LeasedMail } from "../src/agent/lease";
import { ensureRecallSchema } from "../src/agent/recall-ledger";
import { serverInstructions } from "../src/mcp/instructions";
import { createServerFactory } from "../src/mcp/server";
import { registerRecallBackfillTool, registerRecallTools } from "../src/mcp/tools/recall";
import { recallEnabled } from "../src/recall/config";
import { forgetDeadRef } from "../src/recall/dead-ref";
import { RECALL_DRIVEN, runRecallBackfill, runRecallStep, withRecallStep } from "../src/recall/drive";
import type { RecallStore } from "../src/recall/index";
import { embedder, RecallEmbedError } from "../src/recall/embed";
import { ownerPrincipal } from "./fixtures/bound-secrets";
import { USER_A } from "./fixtures/two-users";

afterEach(() => vi.restoreAllMocks());

describe("recall is an explicit deployment opt-in", () => {
  it.each([undefined, "false", "TRUE", "1", "yes", "", " true", "true "])(
    "does not enable indexing for %s", (value) => {
      expect(recallEnabled({ RECALL_ENABLED: value })).toBe(false);
    },
  );

  it("enables only the exact true string", () => {
    expect(recallEnabled({ RECALL_ENABLED: "true" })).toBe(true);
    expect(recallEnabled({})).toBe(false);
  });

  it("the real server hides both recall tools and wraps no ordinary tool", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    createServerFactory(ownerPrincipal())({ era: "modern" } as never);
    const calls = spy.mock.calls as unknown as [string, unknown, Record<symbol, unknown>][];
    const names = calls.map(([name]) => name);
    expect(names).toContain("mail_get_message");
    expect(names).toContain("mail_find");
    expect(names).not.toContain("mail_recall");
    expect(names).not.toContain("mail_recall_backfill");
    for (const [name, , callback] of calls) expect(callback[RECALL_DRIVEN], name).toBeUndefined();
  });

  it("registrars cannot expose recall tools independently", () => {
    const server = new McpServer({ name: "test", version: "1" });
    const register = vi.spyOn(server, "registerTool");
    const mail = {} as LeasedMail;
    registerRecallTools(server, ownerPrincipal());
    registerRecallBackfillTool(server, mail, ownerPrincipal(), async () => "person");
    expect(register).not.toHaveBeenCalled();
  });

  it("ordinary calls get the plain server and direct drive calls reach no dependencies", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const mail = { withConnectionLease: vi.fn() } as unknown as LeasedMail;
    const grant = vi.fn(async () => "person");
    const deps = vi.fn(() => { throw new Error("must not construct dependencies"); });
    const before = vi.fn();
    const principal = ownerPrincipal();
    expect(withRecallStep(server, principal, mail, grant)).toBe(server);
    await runRecallStep(principal, mail, grant);
    expect(await runRecallBackfill(await principal, mail, grant, deps, before)).toEqual({ kind: "refused" });
    expect(grant).not.toHaveBeenCalled();
    expect(deps).not.toHaveBeenCalled();
    expect(before).not.toHaveBeenCalled();
    expect(mail.withConnectionLease).not.toHaveBeenCalled();
  });

  it("a missing mail result does not construct recall dependencies", async () => {
    const deps = vi.fn(() => { throw new Error("must not construct dependencies"); });
    await forgetDeadRef(await ownerPrincipal(), { mailbox: "INBOX", uidValidity: 1, uid: 1 }, deps);
    expect(deps).not.toHaveBeenCalled();
  });

  it("the production embedder refuses before accessing Workers AI", () => {
    expect(() => embedder()).toThrow(RecallEmbedError);
  });

  it("instructions describe the available mail search without advertising hidden tools", () => {
    const instructions = serverInstructions(false);
    expect(instructions).toContain("automatic indexing are disabled");
    expect(instructions).not.toContain("mail_recall");
    expect(serverInstructions(true)).toContain("mail_recall_backfill");
  });

  it.each(["some", "none"] as const)("an empty object's %s-grant alarm needs no Vectorize binding", async (grants) => {
    const stub = env.USER_AGENT.getByName(USER_A.userId);
    await runInDurableObject(stub, async (instance, state) => {
      ensureRecallSchema(state.storage.sql);
      state.storage.sql.exec("delete from recall_vectors");
      state.storage.sql.exec("delete from recall_state");
      state.storage.kv.put("own-name", USER_A.userId);
      const store = vi.spyOn(instance, "vectorStore").mockImplementation(() => { throw new Error("missing binding"); });
      vi.spyOn(instance, "grantsRemain").mockResolvedValue(grants);
      await instance.alarm();
      expect(store).not.toHaveBeenCalled();
    });
  });

  it("disabled indexing still expires pre-existing vectors without embedding mail", async () => {
    const stub = env.USER_AGENT.getByName(USER_A.userId);
    await runInDurableObject(stub, async (instance, state) => {
      ensureRecallSchema(state.storage.sql);
      state.storage.sql.exec("delete from recall_vectors");
      state.storage.sql.exec("delete from recall_state");
      state.storage.kv.put("own-name", USER_A.userId);
      const id = "a".repeat(64);
      state.storage.sql.exec(
        "insert into recall_vectors (vector_id, mailbox, uid_validity, expires_at) values (?, ?, 1, ?)",
        id, "INBOX", Date.now() - 1,
      );
      const deleteIds = vi.fn(async () => {});
      vi.spyOn(instance, "vectorStore").mockReturnValue({ deleteIds } as unknown as RecallStore);
      vi.spyOn(instance, "grantsRemain").mockResolvedValue("some");
      await instance.alarm();
      expect(deleteIds).toHaveBeenCalledWith([id]);
      expect(state.storage.sql.exec("select vector_id from recall_vectors").toArray()).toEqual([]);
    });
  });

});

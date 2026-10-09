// Registered bulk tools over the real owner-local Durable Object and lease.
// Only the mailbox read and move are replaced: no live socket or Apple login.
// These cases join the signed preview, durable claim and bounded move boundary.

import type { McpServer } from "@modelcontextprotocol/server";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

vi.mock("../src/mail/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail/service")>()),
  readMoveSet: vi.fn(),
}));
vi.mock("../src/mail/triage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail/triage")>()),
  moveMessages: vi.fn(),
}));
vi.mock("../src/mail/socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail/socket")>()),
  connectImap: vi.fn(() => { throw new Error("Unexpected live socket path"); }),
}));

import { agentFor, createLeasedMail } from "../src/agent/lease";
import {
  BULK_MAIL_STORAGE_PREFIX,
  BULK_MAIL_TTL_MS,
  type BulkMailJobAnswer,
  type BulkMailJobView,
} from "../src/agent/mail-bulk";
import {
  mintConfirmation,
  verifyConfirmation,
  type NormalizedMailMove,
} from "../src/confirm";
import { ImapConnectError } from "../src/errors";
import { decodeMessageId, encodeFolderId, encodeMessageId } from "../src/mail/ids";
import { createSessionGate, readMoveSet, type FolderSummary, type MoveSetFacts } from "../src/mail/service";
import { connectImap } from "../src/mail/socket";
import { moveMessages, type MessageMoveResult, type MoveEntry, type MoveOutcome } from "../src/mail/triage";
import { registerBulkMailTools, registerMailTools } from "../src/mcp/tools/mail";
import type { ToolResult } from "../src/mcp/untrusted";
import type { Principal } from "../src/principal";
import { entryEnv, refusedPrincipal } from "./fixtures/bound-secrets";
import { USER_A, USER_B, testPrincipal } from "./fixtures/two-users";

const SOURCE_VALIDITY = 12345;
const DESTINATION_VALIDITY = 67890;
const SOURCE = encodeFolderId({ mailbox: "INBOX" });
const ARCHIVE = encodeFolderId({ mailbox: "Archive" });
const TRASH = encodeFolderId({ mailbox: "Trash" });
const PRIVATE_SUBJECT = "Untrusted subject that must never enter the job";
const PRIVATE_SENDER = "sender@example.invalid";

type Callback = (args: Record<string, unknown>) => Promise<ToolResult>;
interface Registered { callback: Callback; schema: ZodType }
interface Preview {
  confirmToken: string;
  jobId: string;
  change: NormalizedMailMove;
  count: number;
  confirmationLine: string;
  execution: "resumable";
}

let actor: Principal;
let other: Principal;

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => encodeMessageId({
    mailbox: "INBOX", uidValidity: SOURCE_VALIDITY, uid: index + 1,
  }));
}

function folder(mailbox: string, role: "inbox" | "archive" | "trash"): FolderSummary {
  return {
    id: encodeFolderId({ mailbox }), wireName: mailbox, displayName: mailbox,
    role, roleSource: "special-use", attributes: [`\\${role}`],
    totalCount: 2000, unreadCount: 0,
  };
}

function facts(uids: readonly number[]): MoveSetFacts {
  return {
    listing: {
      folders: [folder("INBOX", "inbox"), folder("Archive", "archive"), folder("Trash", "trash")],
      delimiter: "/", countsSource: "list-status",
    },
    found: uids.map((uid) => ({
      fingerprint: { uid, flags: [], size: 1000 + uid, internalDate: 1_700_000_000 + uid, modSeq: "4611686018427387905" },
      subject: PRIVATE_SUBJECT, from: PRIVATE_SENDER, date: "Thu, 01 Oct 2026 12:00:00 +0000",
    })),
    missing: [], changeNumbers: "available",
  };
}

function moved(entry: MoveEntry): MessageMoveResult {
  return { uid: entry.uid, outcome: "moved", reason: "verified-gone", newUid: entry.uid + 10000, destinationUidValidity: DESTINATION_VALIDITY };
}
function success(entries: readonly MoveEntry[]): MoveOutcome {
  return { applied: true, results: entries.map(moved) };
}
function result(entry: MoveEntry, outcome: MessageMoveResult["outcome"], reason: MessageMoveResult["reason"]): MessageMoveResult {
  return { uid: entry.uid, outcome, reason, newUid: null, destinationUidValidity: null };
}

/** Build a fresh request gate each time, as independent MCP requests do. */
function tools(principal = Promise.resolve(actor), regular = false): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool(name: string, options: { inputSchema: ZodType }, callback: Callback) {
      registered.set(name, { callback, schema: options.inputSchema });
    },
  } as unknown as McpServer;
  const mail = createLeasedMail(createSessionGate());
  if (regular) registerMailTools(server, mail, principal);
  else registerBulkMailTools(server, mail, principal);
  return registered;
}

async function invoke(name: string, args: Record<string, unknown>, principal = Promise.resolve(actor), regular = false): Promise<ToolResult> {
  const registered = tools(principal, regular).get(name);
  expect(registered, `${name} must be registered`).toBeDefined();
  return registered!.callback(registered!.schema.parse(args) as Record<string, unknown>);
}
function body<T>(answer: ToolResult): T { return JSON.parse(answer.content[0]!.text) as T; }
async function preview(count = 26, destination: Record<string, unknown> = { kind: "role", role: "archive" }): Promise<Preview> {
  const answer = await invoke("mail_bulk_preview", { ids: ids(count), destination });
  expect(answer.isError).toBeUndefined();
  const value = body<Preview>(answer);
  expect(value.confirmToken).toBeTypeOf("string");
  return value;
}
async function start(value: Preview): Promise<BulkMailJobView> {
  return job(await invoke("mail_bulk_job", { action: "start", confirmToken: value.confirmToken, change: value.change }));
}
function job(answer: ToolResult): BulkMailJobView {
  expect(answer.isError).toBeUndefined();
  const value = body<BulkMailJobAnswer>(answer);
  expect(value.ok).toBe(true);
  if (!value.ok) throw new Error("Expected a successful job answer");
  return value.job;
}
async function status(jobId: string, offset = 0, limit = 100): Promise<BulkMailJobView> {
  return job(await invoke("mail_bulk_job", { action: "status", jobId, offset, limit }));
}
async function step(jobId: string): Promise<BulkMailJobView> {
  return job(await invoke("mail_bulk_job", { action: "step", jobId }));
}
async function stored(principal = actor): Promise<Record<string, unknown>> {
  return runInDurableObject(agentFor(principal), (_instance, state) => Object.fromEntries(state.storage.kv.list()));
}
async function expireClaim(jobId: string): Promise<void> {
  await runInDurableObject(agentFor(actor), (_instance, state) => {
    const key = `${BULK_MAIL_STORAGE_PREFIX}${jobId}:header`;
    const header = state.storage.kv.get<{ claim: { expiresAt: number } | null }>(key)!;
    expect(header.claim).not.toBeNull();
    header.claim!.expiresAt = Date.now() - 1;
    state.storage.kv.put(key, header);
  });
}

beforeEach(async () => {
  actor = await testPrincipal(USER_A);
  other = await testPrincipal(USER_B);
  for (const principal of [actor, other]) {
    await runInDurableObject(agentFor(principal), (_instance, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
      return state.storage.deleteAlarm();
    });
  }
  vi.mocked(readMoveSet).mockReset().mockImplementation(async (_actor, _leased, _source, uids) => facts(uids));
  vi.mocked(moveMessages).mockReset().mockImplementation(async (_actor, _leased, _source, entries) => success(entries));
  vi.mocked(connectImap).mockClear();
});
afterEach(() => {
  expect(connectImap).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("bulk preview and owner-bound start", () => {
  it("seals more than 25 exact fingerprints without creating a job or changing mail", async () => {
    const value = await preview(61);
    expect(value).toMatchObject({ count: 61, execution: "resumable", change: { op: "move", ids: ids(61), destination: ARCHIVE } });
    expect(value.confirmationLine).toContain("61 messages");
    const payload = await verifyConfirmation(value.confirmToken, entryEnv().CONFIRM_SECRET, actor.userId, "mail-bulk");
    expect(payload).toMatchObject({ t: "mail-bulk", k: "move", j: value.jobId, m: SOURCE, uv: SOURCE_VALIDITY, q: ARCHIVE, qr: "archive" });
    expect(payload.l).toHaveLength(61);
    expect(payload.l[60]).toEqual({ i: 61, z: 1061, d: 1_700_000_061, n: "4611686018427387905" });
    expect(body(await invoke("mail_bulk_job", { action: "status", jobId: value.jobId }))).toEqual({ ok: false, reason: "not-found" });
    expect(moveMessages).not.toHaveBeenCalled();
    expect(Object.keys(await stored()).filter((key) => key.startsWith(BULK_MAIL_STORAGE_PREFIX))).toEqual([]);
  });

  it.each([
    [{ kind: "role", role: "trash" }, TRASH, "trash"],
    [{ kind: "folder", id: ARCHIVE }, ARCHIVE, null],
  ])("supports a reviewed destination %j", async (destination, destinationId, role) => {
    const value = await preview(2, destination as Record<string, unknown>);
    const started = await start(value);
    expect(started).toMatchObject({ destinationFolderId: destinationId, destinationRole: role, counts: { pending: 2 } });
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("keeps the bulk schema at 1000 and the ordinary preview at 25", async () => {
    const registered = tools().get("mail_bulk_preview")!;
    expect(registered.schema.safeParse({ ids: ids(1000), destination: { kind: "role", role: "archive" } }).success).toBe(true);
    expect(registered.schema.safeParse({ ids: ids(1001), destination: { kind: "role", role: "archive" } }).success).toBe(false);
    expect(registered.schema.safeParse({ ids: [], destination: { kind: "role", role: "archive" } }).success).toBe(false);
    const ordinary = await invoke("mail_archive", { ids: ids(26) }, Promise.resolve(actor), true);
    expect(body(ordinary)).toMatchObject({ refusal: "too-many", cap: 25 });
    expect(readMoveSet).not.toHaveBeenCalled();
  });

  it("previews and persists the full 1000-entry upper bound without mailbox changes", async () => {
    const value = await preview(1000);
    const started = await start(value);
    expect(started.counts).toEqual({ total: 1000, pending: 1000, moved: 0, needsAttention: 0, inFlight: 0 });
    expect((await status(value.jobId, 900, 100)).entries.map((entry) => entry.id)).toEqual(ids(1000).slice(900));
    expect(readMoveSet).toHaveBeenCalledTimes(1);
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("rejects an expired or corrupted preview token without creating a job", async () => {
    const value = await preview(2);
    const payload = await verifyConfirmation(value.confirmToken, entryEnv().CONFIRM_SECRET, actor.userId, "mail-bulk");
    const expired = await mintConfirmation({ ...payload, x: Math.floor(Date.now() / 1000) - 1 }, entryEnv().CONFIRM_SECRET);
    const [encoded, signature] = value.confirmToken.split(".");
    const corrupted = `${encoded}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    for (const confirmToken of [expired, corrupted]) {
      const answer = await invoke("mail_bulk_job", { action: "start", confirmToken, change: value.change });
      expect(answer.isError).toBe(true);
      expect(body(answer)).toMatchObject({ category: "confirmation_invalid" });
    }
    expect(body(await invoke("mail_bulk_job", { action: "status", jobId: value.jobId }))).toEqual({ ok: false, reason: "not-found" });
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("rejects repeated or mixed-folder ids before the mailbox read", async () => {
    const repeated = await invoke("mail_bulk_preview", { ids: [ids(1)[0], ids(1)[0]], destination: { kind: "role", role: "archive" } });
    expect(body(repeated)).toMatchObject({ refusal: "duplicate-ids" });
    const mixed = await invoke("mail_bulk_preview", { ids: [ids(1)[0], encodeMessageId({ mailbox: "Trash", uidValidity: SOURCE_VALIDITY, uid: 2 })], destination: { kind: "role", role: "archive" } });
    expect(body(mixed)).toMatchObject({ refusal: "mixed-folders" });
    expect(readMoveSet).not.toHaveBeenCalled();
  });

  it("rejects a wrong signed target and any altered scope without spending the valid preview", async () => {
    const value = await preview(2);
    const payload = await verifyConfirmation(value.confirmToken, entryEnv().CONFIRM_SECRET, actor.userId, "mail-bulk");
    const regularToken = await mintConfirmation({ ...payload, t: "mail" }, entryEnv().CONFIRM_SECRET);
    const attempts = [
      { confirmToken: regularToken, change: value.change },
      { confirmToken: value.confirmToken, change: { ...value.change, destination: TRASH } },
      { confirmToken: value.confirmToken, change: { ...value.change, ids: [...value.change.ids].reverse() } },
      { confirmToken: value.confirmToken, change: { ...value.change, ids: value.change.ids.slice(1) } },
    ];
    for (const attempt of attempts) {
      const answer = await invoke("mail_bulk_job", { action: "start", ...attempt });
      expect(answer.isError).toBe(true);
      expect(body(answer)).toMatchObject({ category: "confirmation_invalid" });
    }
    const regularCommit = await invoke("mail_commit", { confirmToken: value.confirmToken, change: value.change }, Promise.resolve(actor), true);
    expect(regularCommit.isError).toBe(true);
    expect(body(regularCommit)).toMatchObject({ category: "confirmation_invalid" });
    expect((await start(value)).counts.pending).toBe(2);
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("returns the same durable job on repeated start without resetting completed entries", async () => {
    const value = await preview(26);
    const first = await start(value);
    const repeated = body<{ ok: true; existing: boolean; job: BulkMailJobView }>(await invoke("mail_bulk_job", { action: "start", confirmToken: value.confirmToken, change: value.change }));
    expect(repeated.existing).toBe(true);
    expect(repeated.job).toEqual(first);
    expect(moveMessages).not.toHaveBeenCalled();
    const advanced = await step(value.jobId);
    expect(advanced.counts).toMatchObject({ moved: 25, pending: 1 });
    expect(await start(value)).toEqual(advanced);
    expect(moveMessages).toHaveBeenCalledTimes(1);
  });

  it("atomically joins concurrent retries of the same start to one job", async () => {
    const value = await preview(26);
    const request = { action: "start", confirmToken: value.confirmToken, change: value.change };
    const first = invoke("mail_bulk_job", request);
    const second = invoke("mail_bulk_job", request);
    const firstAnswer = body<{ ok: true; existing: boolean; job: BulkMailJobView }>(await first);
    const secondAnswer = body<{ ok: true; existing: boolean; job: BulkMailJobView }>(await second);
    expect([firstAnswer.existing, secondAnswer.existing].sort()).toEqual([false, true]);
    expect(firstAnswer.job).toEqual(secondAnswer.job);
    expect(firstAnswer.job.counts.pending).toBe(26);
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("keeps job access, cancellation and the confirmation owner-local", async () => {
    const value = await preview(26);
    const started = await start(value);
    const wrongStart = await invoke("mail_bulk_job", { action: "start", confirmToken: value.confirmToken, change: value.change }, Promise.resolve(other));
    expect(wrongStart.isError).toBe(true);
    expect(body(wrongStart)).toMatchObject({ category: "confirmation_invalid" });
    for (const action of ["status", "step", "cancel"]) {
      expect(body(await invoke("mail_bulk_job", { action, jobId: value.jobId }, Promise.resolve(other)))).toEqual({ ok: false, reason: "not-found" });
    }
    expect(await status(value.jobId)).toEqual(started);
    expect(moveMessages).not.toHaveBeenCalled();
    expect(Object.keys(await stored(other)).filter((key) => key.startsWith(BULK_MAIL_STORAGE_PREFIX))).toEqual([]);
  });

  it("rejects unauthenticated callers before reading or changing owner state", async () => {
    const before = await stored();
    const jobId = crypto.randomUUID();
    const requests = [
      ["mail_bulk_preview", { ids: ids(1), destination: { kind: "role", role: "archive" } }],
      ["mail_bulk_job", { action: "start", confirmToken: "untrusted", change: { op: "move", ids: ids(1), destination: ARCHIVE } }],
      ...["step", "status", "cancel"].map((action) => ["mail_bulk_job", { action, jobId }]),
    ] as [string, Record<string, unknown>][];
    for (const [name, args] of requests) {
      const answer = await invoke(name, args, refusedPrincipal("appPassword"));
      expect(answer.isError).toBe(true);
      expect(body(answer)).toMatchObject({ category: "auth_failed" });
    }
    expect(await stored()).toEqual(before);
    expect(readMoveSet).not.toHaveBeenCalled();
    expect(moveMessages).not.toHaveBeenCalled();
  });
});

describe("bounded, resumable execution", () => {
  it("advances 61 messages in three leased calls and never repeats completed entries", async () => {
    const value = await preview(61);
    await start(value);
    const observed: number[][] = [];
    vi.mocked(moveMessages).mockImplementation(async (principal, _leased, source, entries, destination, bounds) => {
      expect(principal).toBe(actor);
      expect(source).toEqual({ mailbox: "INBOX", uidValidity: SOURCE_VALIDITY });
      expect(destination).toBe("Archive");
      const lease = (await stored()).lease as { expiresAt: number };
      expect(lease).toBeDefined();
      expect(bounds?.writeDeadlineAt).toBeTypeOf("number");
      expect(bounds!.writeDeadlineAt!).toBeLessThanOrEqual(lease.expiresAt);
      expect(bounds!.writeDeadlineAt!).toBeGreaterThan(Date.now());
      const during = await status(value.jobId);
      expect(during.counts.inFlight).toBe(entries.length);
      expect(entries.length).toBeLessThanOrEqual(25);
      observed.push(entries.map((entry) => entry.uid));
      return success(entries);
    });
    expect((await step(value.jobId)).counts).toMatchObject({ moved: 25, pending: 36, inFlight: 0 });
    expect((await step(value.jobId)).counts).toMatchObject({ moved: 50, pending: 11, inFlight: 0 });
    const finished = await step(value.jobId);
    expect(finished.status).toBe("completed");
    expect(finished.counts).toEqual({ total: 61, moved: 61, pending: 0, inFlight: 0, needsAttention: 0 });
    expect(observed.map((batch) => batch.length)).toEqual([25, 25, 11]);
    expect(observed.flat()).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
    expect(await step(value.jobId)).toEqual(finished);
    expect(moveMessages).toHaveBeenCalledTimes(3);
    expect((await stored()).lease).toBeUndefined();
    expect(decodeMessageId(finished.entries[0]!.result!.newId!)).toEqual({ mailbox: "Archive", uidValidity: DESTINATION_VALIDITY, uid: 10001 });
  });

  it("resumes only entries explicitly reported not-attempted", async () => {
    const value = await preview(6);
    await start(value);
    vi.mocked(moveMessages).mockImplementationOnce(async (_actor, _leased, _source, entries) => ({
      applied: true,
      results: [
        moved(entries[0]!),
        { ...result(entries[1]!, "copied_not_removed", "still-in-source"), newUid: 10002, destinationUidValidity: DESTINATION_VALIDITY },
        result(entries[2]!, "unknown", "connection-lost"),
        result(entries[3]!, "not_copied", "copy-refused"),
        result(entries[4]!, "not_copied", "not-attempted"),
        result(entries[5]!, "not_copied", "not-attempted"),
      ],
    }));
    const partial = await step(value.jobId);
    expect(partial.counts).toEqual({ total: 6, moved: 1, pending: 2, needsAttention: 3, inFlight: 0 });
    expect(partial.entries.map((entry) => entry.state)).toEqual(["moved", "needs_attention", "needs_attention", "needs_attention", "pending", "pending"]);
    const resumed = await step(value.jobId);
    expect(vi.mocked(moveMessages).mock.calls[1]![3].map((entry) => entry.uid)).toEqual([5, 6]);
    expect(resumed).toMatchObject({ status: "needs_attention", counts: { moved: 3, pending: 0, needsAttention: 3 } });
    expect(await step(value.jobId)).toEqual(resumed);
    expect(moveMessages).toHaveBeenCalledTimes(2);
  });

  it("preserves unchanged entries after the move's pre-write fingerprint refusal", async () => {
    const value = await preview(4);
    await start(value);
    vi.mocked(moveMessages).mockResolvedValueOnce({ applied: false, refusal: "changed-since-preview", changedUids: [2] });
    const refused = await step(value.jobId);
    expect(refused.counts).toMatchObject({ pending: 3, moved: 0, needsAttention: 1 });
    expect(refused.entries[1]!.result).toEqual({ outcome: "not_copied", reason: "changed-since-preview", newId: null });
    const resumed = await step(value.jobId);
    expect(vi.mocked(moveMessages).mock.calls[1]![3].map((entry) => entry.uid)).toEqual([1, 3, 4]);
    expect(resumed.counts).toMatchObject({ pending: 0, moved: 3, needsAttention: 1 });
  });

  it("makes a thrown or lost mailbox result uncertain and advances only untouched later entries", async () => {
    const value = await preview(30);
    await start(value);
    vi.mocked(moveMessages).mockRejectedValueOnce(new ImapConnectError());
    const failed = await invoke("mail_bulk_job", { action: "step", jobId: value.jobId });
    expect(body(failed)).toMatchObject({ executionError: "connection_failed" });
    const uncertain = job(failed);
    expect(uncertain.counts).toEqual({ total: 30, moved: 0, pending: 5, inFlight: 0, needsAttention: 25 });
    expect(uncertain.entries.slice(0, 25).every((entry) => entry.result?.outcome === "unknown" && entry.result.reason === "connection-lost")).toBe(true);
    const resumed = await step(value.jobId);
    expect(vi.mocked(moveMessages).mock.calls[1]![3].map((entry) => entry.uid)).toEqual([26, 27, 28, 29, 30]);
    expect(resumed.counts).toMatchObject({ moved: 5, needsAttention: 25, pending: 0 });
    expect(await step(value.jobId)).toEqual(resumed);
    expect(moveMessages).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost step response through status without replaying its committed batch", async () => {
    const value = await preview(30);
    await start(value);
    // Deliberately discard the answer, as when the caller loses its connection.
    await invoke("mail_bulk_job", { action: "step", jobId: value.jobId });
    const recovered = await status(value.jobId);
    expect(recovered.counts).toMatchObject({ moved: 25, pending: 5 });
    expect((await start(value)).counts).toEqual(recovered.counts);
    expect((await step(value.jobId)).status).toBe("completed");
    expect(vi.mocked(moveMessages).mock.calls.map((call) => call[3].map((entry) => entry.uid))).toEqual([
      Array.from({ length: 25 }, (_, index) => index + 1), [26, 27, 28, 29, 30],
    ]);
  });

  it("keeps an incomplete result claimed until expiry rather than replaying it", async () => {
    const value = await preview(26);
    await start(value);
    vi.mocked(moveMessages).mockResolvedValueOnce({ applied: true, results: [] });
    const incomplete = await invoke("mail_bulk_job", { action: "step", jobId: value.jobId });
    expect(incomplete.isError).toBe(true);
    expect((await status(value.jobId)).counts).toMatchObject({ inFlight: 25, pending: 1 });
    expect(body(await invoke("mail_bulk_job", { action: "step", jobId: value.jobId }))).toEqual({ ok: false, reason: "busy" });
    expect(moveMessages).toHaveBeenCalledTimes(1);
    await expireClaim(value.jobId);
    const recovered = await step(value.jobId);
    expect(recovered.counts).toMatchObject({ needsAttention: 25, moved: 1, pending: 0 });
    expect(vi.mocked(moveMessages).mock.calls[1]![3].map((entry) => entry.uid)).toEqual([26]);
  });

  it.each(["mailbox-read-only", "removal-not-kept", "commands-unavailable"] as const)(
    "records the whole-list refusal %s without authorizing a retry",
    async (refusal) => {
      const value = await preview(2);
      await start(value);
      vi.mocked(moveMessages).mockResolvedValueOnce({ applied: false, refusal });
      const refused = await step(value.jobId);
      expect(refused).toMatchObject({ status: "needs_attention", counts: { moved: 0, pending: 0, needsAttention: 2 } });
      expect(refused.entries.every((entry) => entry.result?.outcome === "not_copied" && entry.result.reason === refusal)).toBe(true);
      expect(await step(value.jobId)).toEqual(refused);
      expect(moveMessages).toHaveBeenCalledTimes(1);
    },
  );

  it("never reclaims expired in-flight work after an abandoned request", async () => {
    const value = await preview(30);
    await start(value);
    const abandoned = await agentFor(actor).bulkMailClaim(value.jobId);
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok || abandoned.claim === null) throw new Error("Expected an initial claim");
    expect(abandoned.claim.entries).toHaveLength(25);
    await expireClaim(value.jobId);
    const recovered = await status(value.jobId);
    expect(recovered.counts).toMatchObject({ needsAttention: 25, pending: 5, inFlight: 0 });
    expect(recovered.entries[0]!.result).toEqual({ outcome: "unknown", reason: "claim-expired", newId: null });
    expect((await step(value.jobId)).counts).toMatchObject({ needsAttention: 25, moved: 5, pending: 0 });
    expect(vi.mocked(moveMessages).mock.calls[0]![3].map((entry) => entry.uid)).toEqual([26, 27, 28, 29, 30]);
    expect(await agentFor(actor).bulkMailFinish(value.jobId, abandoned.claim.token, [])).toEqual({ ok: false, reason: "stale-claim" });
  });

  it("refuses a competing step while the first request owns the connection lease", async () => {
    const value = await preview(26);
    await start(value);
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(moveMessages).mockImplementationOnce(async (_actor, _leased, _source, entries) => {
      begin();
      await held;
      return success(entries);
    });
    const first = invoke("mail_bulk_job", { action: "step", jobId: value.jobId });
    await started;
    try {
      const second = await invoke("mail_bulk_job", { action: "step", jobId: value.jobId });
      expect(second.isError).toBe(true);
      expect(body(second)).toMatchObject({ category: "connection_busy" });
      expect(moveMessages).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(job(await first).counts).toMatchObject({ moved: 25, pending: 1 });
  });

  it("paginates stable original entries without taking a connection or writing state", async () => {
    const value = await preview(121);
    await start(value);
    const before = await stored();
    const first = await status(value.jobId, 0, 100);
    const last = await status(value.jobId, 100, 100);
    expect(first.entries).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    expect(last.entries).toHaveLength(21);
    expect(last.nextOffset).toBeNull();
    expect([...first.entries, ...last.entries].map((entry) => entry.id)).toEqual(ids(121));
    expect(last.entries[0]!.index).toBe(100);
    expect(await stored()).toEqual(before);
    expect(readMoveSet).toHaveBeenCalledTimes(1);
    expect(moveMessages).not.toHaveBeenCalled();
  });
});

describe("cancellation, expiry and retained data", () => {
  it("cancels future claims and an idempotent start cannot restart a canceled job", async () => {
    const value = await preview(26);
    await start(value);
    const canceled = job(await invoke("mail_bulk_job", { action: "cancel", jobId: value.jobId }));
    expect(canceled.status).toBe("canceled");
    expect(canceled.counts.pending).toBe(26);
    expect(body(await invoke("mail_bulk_job", { action: "step", jobId: value.jobId }))).toEqual({ ok: false, reason: "canceled" });
    expect((await start(value)).status).toBe("canceled");
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("lets an already-running batch report its result after cancellation without starting another", async () => {
    const value = await preview(26);
    await start(value);
    vi.mocked(moveMessages).mockImplementationOnce(async (_actor, _leased, _source, entries) => {
      const canceled = job(await invoke("mail_bulk_job", { action: "cancel", jobId: value.jobId }));
      expect(canceled).toMatchObject({ status: "canceled", counts: { inFlight: 25, pending: 1 } });
      return success(entries);
    });
    const finished = await step(value.jobId);
    expect(finished).toMatchObject({ status: "canceled", counts: { moved: 25, pending: 1, inFlight: 0 } });
    expect(body(await invoke("mail_bulk_job", { action: "step", jobId: value.jobId }))).toEqual({ ok: false, reason: "canceled" });
    expect(moveMessages).toHaveBeenCalledTimes(1);
  });

  it("does not execute an expired job", async () => {
    const value = await preview(26);
    await start(value);
    await runInDurableObject(agentFor(actor), (_instance, state) => {
      const key = `${BULK_MAIL_STORAGE_PREFIX}${value.jobId}:header`;
      const header = state.storage.kv.get<{ createdAt: number; expiresAt: number }>(key)!;
      header.expiresAt = Date.now() - 1;
      header.createdAt = header.expiresAt - BULK_MAIL_TTL_MS;
      state.storage.kv.put(key, header);
    });
    expect((await status(value.jobId)).status).toBe("expired");
    expect(body(await invoke("mail_bulk_job", { action: "step", jobId: value.jobId }))).toEqual({ ok: false, reason: "expired" });
    expect(moveMessages).not.toHaveBeenCalled();
  });

  it("retains only scope, fingerprints and outcomes, never credentials or message text", async () => {
    const value = await preview(26);
    await start(value);
    const advanced = await step(value.jobId);
    const persisted = await stored();
    const serialized = JSON.stringify(persisted);
    expect(Object.keys(persisted).some((key) => key.startsWith(BULK_MAIL_STORAGE_PREFIX))).toBe(true);
    for (const forbidden of [USER_A.appleId, USER_A.appPassword, entryEnv().CONFIRM_SECRET!, value.confirmToken, PRIVATE_SUBJECT, PRIVATE_SENDER]) {
      expect(forbidden.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(forbidden);
      expect(JSON.stringify(advanced)).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('"appPassword"');
    expect(serialized).not.toContain('"confirmToken"');
    expect(serialized).not.toContain('"subject"');
    expect(serialized).toContain('"n":"4611686018427387905"');
  });
});

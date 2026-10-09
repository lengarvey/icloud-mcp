// Pure owner-local state tests: no session, socket, credentials, or live mail.
import { describe, expect, it } from "vitest";
import {
  BULK_MAIL_CLAIM_MAX,
  BULK_MAIL_CLAIM_MS,
  BULK_MAIL_MAX_ENTRIES,
  BULK_MAIL_MAX_JOBS,
  BULK_MAIL_STORAGE_PREFIX,
  BULK_MAIL_TTL_MS,
  cancelBulkMailJob,
  claimBulkMailJob,
  createBulkMailJob,
  finishBulkMailJob,
  getBulkMailJob,
  parseBulkMailCreateInput,
  parseBulkMailResults,
  type BulkMailClaim,
  type BulkMailCreateInput,
  type BulkMailJobAnswer,
  type BulkMailJobView,
  type BulkMailResultInput,
  type BulkMailStorage,
} from "../src/agent/mail-bulk";

class MemoryStorage implements BulkMailStorage {
  readonly values = new Map<string, unknown>();
  writes = 0;
  get<T = unknown>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put<T>(key: string, value: T): void {
    this.writes++;
    this.values.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    this.writes++;
    return this.values.delete(key);
  }
}

const NOW = 1_800_000_000_000;
const JOB_ID = "12345678-1234-4123-8123-123456789abc";
function input(count = 3, jobId = JOB_ID): BulkMailCreateInput {
  return {
    jobId, sourceFolderId: "source-folder-id", uidValidity: 73,
    destinationFolderId: "destination-folder-id", destinationRole: "archive",
    entries: Array.from({ length: count }, (_, index) => ({ i: index + 1, z: 1200 + index, d: 1_750_000_000 + index, n: "9223372036854775807" })),
    ids: Array.from({ length: count }, (_, index) => `message-id-${index}`),
  };
}
function job(answer: BulkMailJobAnswer): BulkMailJobView {
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error("expected a job");
  return answer.job;
}
function claim(storage: MemoryStorage, now = NOW, jobId = JOB_ID): BulkMailClaim {
  const answer = claimBulkMailJob(storage, jobId, now);
  expect(answer.ok).toBe(true);
  if (!answer.ok || answer.claim === null) throw new Error("expected a claim");
  return answer.claim;
}
function moved(index: number): BulkMailResultInput {
  return { index, outcome: "moved", reason: "verified-gone", newId: `new-message-id-${index}` };
}
function unattempted(index: number): BulkMailResultInput {
  return { index, outcome: "not_copied", reason: "not-attempted", newId: null };
}
function create(storage: MemoryStorage, count = 3, jobId = JOB_ID, now = NOW): void {
  expect(createBulkMailJob(storage, input(count, jobId), now).ok).toBe(true);
}

// Each call receives a clock from the object, rather than an RPC caller.
describe("bulk move creation and immutable owner-local scope", () => {
  it("stores an exact 1000-entry set in bounded values and pages status without fingerprints", () => {
    const storage = new MemoryStorage();
    const created = createBulkMailJob(storage, input(BULK_MAIL_MAX_ENTRIES), NOW);
    expect(created.ok && created.existing).toBe(false);
    const first = job(created);
    expect(first.counts).toEqual({ total: 1000, pending: 1000, inFlight: 0, moved: 0, needsAttention: 0 });
    expect(first.entries).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    const last = job(getBulkMailJob(storage, JOB_ID, NOW, 990, 100));
    expect(last.entries.map((one) => one.index)).toEqual(Array.from({ length: 10 }, (_, index) => 990 + index));
    expect(last.nextOffset).toBeNull();
    expect(Object.keys(first.entries[0])).toEqual(["index", "id", "state", "result"]);
    expect(storage.values.size).toBe(102);
    for (const [key, value] of storage.values) {
      expect(key.startsWith(BULK_MAIL_STORAGE_PREFIX)).toBe(true);
      expect(JSON.stringify(value).length).toBeLessThan(128 * 1024);
    }
  });

  it("keeps even maximum-length old and new ids below the KV value size bound", () => {
    const storage = new MemoryStorage();
    const scope = input(25);
    const long = { ...scope, ids: scope.ids.map((_, i) => `m${i}`.padEnd(4096, "x")) };
    expect(createBulkMailJob(storage, long, NOW).ok).toBe(true);
    const slot = claim(storage);
    job(finishBulkMailJob(storage, JOB_ID, slot.token, slot.entries.map(({ index }) => ({ ...moved(index), newId: `n${index}`.padEnd(4096, "y") })), NOW + 1));
    for (const value of storage.values.values()) expect(JSON.stringify(value).length).toBeLessThan(128 * 1024);
  });

  it("returns the same nonce's progress without resetting its deadline or writing", () => {
    const storage = new MemoryStorage();
    create(storage);
    const slot = claim(storage);
    job(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(0), unattempted(1), unattempted(2)], NOW + 1));
    const writes = storage.writes;
    const retry = createBulkMailJob(storage, input(), NOW + 10_000);
    expect(retry.ok && retry.existing).toBe(true);
    expect(job(retry).counts).toMatchObject({ pending: 2, moved: 1 });
    expect(job(retry).expiresAt).toBe(NOW + BULK_MAIL_TTL_MS);
    expect(storage.writes).toBe(writes);
  });

  it.each([
    ["source folder", { sourceFolderId: "another-source" }],
    ["destination folder", { destinationFolderId: "another-destination" }],
    ["destination role", { destinationRole: "trash" }],
    ["source generation", { uidValidity: 74 }],
    ["message id", { ids: ["different-id", "message-id-1", "message-id-2"] }],
    ["fingerprint", { entries: input().entries.map((entry, index) => index === 0 ? { ...entry, z: 9000 } : entry) }],
    ["entry order", { entries: [...input().entries].reverse(), ids: [...input().ids].reverse() }],
  ])("refuses a changed %s on the same nonce", (_label, change) => {
    const storage = new MemoryStorage();
    create(storage);
    const writes = storage.writes;
    expect(createBulkMailJob(storage, { ...input(), ...change }, NOW)).toEqual({ ok: false, reason: "scope-mismatch" });
    expect(storage.writes).toBe(writes);
  });

  it.each([
    null, {}, { ...input(), extra: "do-not-store" }, { ...input(), jobId: "untrusted-key" },
    { ...input(), entries: [] }, input(1001), { ...input(), ids: ["message-id-0"] },
    { ...input(), ids: ["same", "same", "third"] },
    { ...input(), entries: [input().entries[0], input().entries[0], input().entries[2]] },
    { ...input(), entries: [{ ...input().entries[0], extra: "do-not-store" }] , ids: ["one"] },
    { ...input(), entries: [{ i: 1, z: 1, d: 1, n: 123 }], ids: ["one"] },
    { ...input(), entries: [{ i: 1, z: 1, d: 1, n: "1e3" }], ids: ["one"] },
    { ...input(), uidValidity: 0 }, { ...input(), uidValidity: 0x100000000 },
    { ...input(), destinationRole: "sent" }, { ...input(), destinationFolderId: "source-folder-id" },
    { ...input(), sourceFolderId: "contains whitespace" },
  ])("rejects malformed create input before any storage write", (value) => {
    const storage = new MemoryStorage();
    expect(parseBulkMailCreateInput(value)).toBeNull();
    expect(createBulkMailJob(storage, value, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(storage.writes).toBe(0);
  });

  it("never shares jobs between owner storage handles", () => {
    const alice = new MemoryStorage();
    const bob = new MemoryStorage();
    create(alice);
    expect(getBulkMailJob(bob, JOB_ID, NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(claimBulkMailJob(bob, JOB_ID, NOW)).toEqual({ ok: false, reason: "not-found" });
    create(bob, 1);
    expect(job(getBulkMailJob(alice, JOB_ID, NOW)).counts.total).toBe(3);
    expect(job(getBulkMailJob(bob, JOB_ID, NOW)).counts.total).toBe(1);
  });

  it("copies validated inputs so caller mutations cannot change stored scope", () => {
    const storage = new MemoryStorage();
    const value = input();
    createBulkMailJob(storage, value, NOW);
    (value.entries[0] as { z: number }).z = 9;
    (value.ids as string[])[0] = "changed";
    expect(claim(storage).entries[0]).toMatchObject({ id: "message-id-0", entry: { z: 1200 } });
  });
});

describe("claims, exact results, and safe continuation", () => {
  it("durably marks at most25 entries before returning and refuses overlapping claims", () => {
    const storage = new MemoryStorage();
    create(storage, 60);
    const slot = claim(storage);
    expect(slot.entries).toHaveLength(BULK_MAIL_CLAIM_MAX);
    expect(slot.expiresAt).toBe(NOW + BULK_MAIL_CLAIM_MS);
    expect(job(getBulkMailJob(storage, JOB_ID, NOW)).counts).toMatchObject({ pending: 35, inFlight: 25 });
    const writes = storage.writes;
    expect(claimBulkMailJob(storage, JOB_ID, NOW + 1)).toEqual({ ok: false, reason: "busy" });
    expect(storage.writes).toBe(writes);
    job(finishBulkMailJob(storage, JOB_ID, slot.token, slot.entries.map(({ index }) => moved(index)), NOW + 2));
    const next = claim(storage, NOW + 3);
    expect(next.token).not.toBe(slot.token);
    expect(next.entries.map((one) => one.index)).toEqual(Array.from({ length: 25 }, (_, i) => i + 25));
  });

  it("only explicit not-copied/not-attempted becomes pending; all other failures are terminal", () => {
    const storage = new MemoryStorage();
    create(storage, 6);
    const slot = claim(storage);
    const answer = job(finishBulkMailJob(storage, JOB_ID, slot.token, [
      moved(0), unattempted(1),
      { index: 2, outcome: "copied_not_removed", reason: "still-in-source", newId: "copy-id" },
      { index: 3, outcome: "unknown", reason: "connection-lost", newId: null },
      { index: 4, outcome: "not_copied", reason: "copy-refused", newId: null },
      { index: 5, outcome: "not_copied", reason: "changed-since-preview", newId: null },
    ], NOW + 1));
    expect(answer.counts).toEqual({ total: 6, pending: 1, inFlight: 0, moved: 1, needsAttention: 4 });
    expect(answer.entries[2].result).toEqual({ outcome: "copied_not_removed", reason: "still-in-source", newId: "copy-id" });
    expect(claim(storage, NOW + 2).entries.map((one) => one.index)).toEqual([1]);
  });

  it.each(["changed-since-preview", "mailbox-read-only", "commands-unavailable", "removal-not-kept"] as const)("keeps whole-session refusal %s terminal", (reason) => {
    const storage = new MemoryStorage();
    create(storage, 1);
    const slot = claim(storage);
    const final = job(finishBulkMailJob(storage, JOB_ID, slot.token, [{ index: 0, outcome: "not_copied", reason, newId: null }], NOW + 1));
    expect(final.status).toBe("needs_attention");
    expect(final.counts.needsAttention).toBe(1);
    expect(claimBulkMailJob(storage, JOB_ID, NOW + 2)).toMatchObject({ ok: true, claim: null });
  });

  it("missing results become unknown instead of becoming pending", () => {
    const storage = new MemoryStorage();
    create(storage);
    const slot = claim(storage);
    const final = job(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(0)], NOW + 1));
    expect(final.counts).toMatchObject({ pending: 0, moved: 1, needsAttention: 2 });
    expect(final.entries[1].result).toEqual({ outcome: "unknown", reason: "result-missing", newId: null });
  });

  it("a wrong token, duplicate result, or index outside the claim never writes", () => {
    const storage = new MemoryStorage();
    create(storage, 30);
    const slot = claim(storage);
    const writes = storage.writes;
    expect(finishBulkMailJob(storage, JOB_ID, crypto.randomUUID(), [moved(0)], NOW + 1)).toEqual({ ok: false, reason: "stale-claim" });
    expect(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(0), moved(0)], NOW + 1)).toEqual({ ok: false, reason: "invalid" });
    expect(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(29)], NOW + 1)).toEqual({ ok: false, reason: "invalid" });
    expect(storage.writes).toBe(writes);
  });

  it.each([
    [{ ...moved(0), reason: "server-secret-text" }],
    [{ ...moved(0), extra: "server-secret-text" }],
    [{ ...moved(0), newId: null }],
    [{ ...moved(0), reason: "copy-refused" }],
    [{ ...unattempted(0), newId: "impossible-copy" }],
    [{ ...unattempted(0), outcome: "unknown" }],
    [{ ...unattempted(0), outcome: "mystery" }],
    [{ ...unattempted(0), index: -1 }],
    [{ ...unattempted(0), index: 1.5 }],
    Array.from({ length: 26 }, (_, index) => moved(index)),
  ].map((value) => ({ value })))("rejects unsanitized or inconsistent outcomes", ({ value }) => {
    expect(parseBulkMailResults(value)).toBeNull();
  });

  it("a replayed completion cannot overwrite terminal evidence", () => {
    const storage = new MemoryStorage();
    create(storage, 1);
    const slot = claim(storage);
    const final = job(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(0)], NOW + 1));
    expect(final.status).toBe("completed");
    const writes = storage.writes;
    expect(finishBulkMailJob(storage, JOB_ID, slot.token, [unattempted(0)], NOW + 2)).toEqual({ ok: false, reason: "stale-claim" });
    expect(storage.writes).toBe(writes);
    expect(job(getBulkMailJob(storage, JOB_ID, NOW + 3)).entries[0].result).toEqual({ outcome: "moved", reason: "verified-gone", newId: "new-message-id-0" });
  });

  it("an abandoned claim becomes unknown and continuation skips every possibly attempted entry", () => {
    const storage = new MemoryStorage();
    create(storage, 30);
    const first = claim(storage);
    const writes = storage.writes;
    const abandoned = job(getBulkMailJob(storage, JOB_ID, first.expiresAt));
    expect(abandoned.counts).toEqual({ total: 30, pending: 5, inFlight: 0, moved: 0, needsAttention: 25 });
    expect(abandoned.entries[0].result).toEqual({ outcome: "unknown", reason: "claim-expired", newId: null });
    expect(storage.writes).toBe(writes);
    expect(finishBulkMailJob(storage, JOB_ID, first.token, [moved(0)], first.expiresAt)).toEqual({ ok: false, reason: "stale-claim" });
    const next = claim(storage, first.expiresAt);
    expect(next.entries.map((one) => one.index)).toEqual([25, 26, 27, 28, 29]);
    expect(next.token).not.toBe(first.token);
    const final = job(finishBulkMailJob(storage, JOB_ID, next.token, next.entries.map(({ index }) => moved(index)), first.expiresAt + 1));
    expect(final.counts).toEqual({ total: 30, pending: 0, inFlight: 0, moved: 5, needsAttention: 25 });
    expect(final.status).toBe("needs_attention");
  });
});

describe("cancellation, expiry, retention, and fail-closed storage", () => {
  it("cancel freezes pending work, including explicitly unattempted results from an existing claim", () => {
    const storage = new MemoryStorage();
    create(storage, 30);
    const slot = claim(storage);
    const canceled = job(cancelBulkMailJob(storage, JOB_ID, NOW + 1));
    expect(canceled.status).toBe("canceled");
    expect(canceled.counts).toMatchObject({ inFlight: 25, pending: 5 });
    expect(claimBulkMailJob(storage, JOB_ID, NOW + 2)).toEqual({ ok: false, reason: "canceled" });
    const finished = job(finishBulkMailJob(storage, JOB_ID, slot.token, slot.entries.map(({ index }) => index === 0 ? moved(index) : unattempted(index)), NOW + 3));
    expect(finished.status).toBe("canceled");
    expect(finished.counts).toMatchObject({ moved: 1, pending: 29, inFlight: 0 });
    expect(claimBulkMailJob(storage, JOB_ID, NOW + 4)).toEqual({ ok: false, reason: "canceled" });
    expect(job(createBulkMailJob(storage, input(30), NOW + 5)).status).toBe("canceled");
  });

  it("cancel is idempotent and allows no first claim", () => {
    const storage = new MemoryStorage();
    create(storage);
    const first = job(cancelBulkMailJob(storage, JOB_ID, NOW + 1));
    const writes = storage.writes;
    expect(job(cancelBulkMailJob(storage, JOB_ID, NOW + 2))).toEqual(first);
    expect(storage.writes).toBe(writes);
    expect(claimBulkMailJob(storage, JOB_ID, NOW + 3)).toEqual({ ok: false, reason: "canceled" });
  });

  it("does not create another job while canceled in-flight work can still be running", () => {
    const storage = new MemoryStorage();
    create(storage);
    const slot = claim(storage);
    cancelBulkMailJob(storage, JOB_ID, NOW + 1);
    const nextId = crypto.randomUUID();
    expect(createBulkMailJob(storage, input(1, nextId), NOW + 2)).toEqual({ ok: false, reason: "busy" });
    expect(createBulkMailJob(storage, input(1, nextId), slot.expiresAt).ok).toBe(true);
  });

  it("expires at24h, caps the final claim, preserves evidence and performs no more writes", () => {
    const storage = new MemoryStorage();
    create(storage, 2);
    const expiresAt = NOW + BULK_MAIL_TTL_MS;
    const slot = claim(storage, expiresAt - 1);
    expect(slot.expiresAt).toBe(expiresAt);
    const writes = storage.writes;
    expect(claimBulkMailJob(storage, JOB_ID, expiresAt)).toEqual({ ok: false, reason: "expired" });
    expect(cancelBulkMailJob(storage, JOB_ID, expiresAt)).toEqual({ ok: false, reason: "expired" });
    expect(finishBulkMailJob(storage, JOB_ID, slot.token, [moved(0), moved(1)], expiresAt)).toEqual({ ok: false, reason: "expired" });
    const expired = job(getBulkMailJob(storage, JOB_ID, expiresAt));
    expect(expired.status).toBe("expired");
    expect(expired.counts).toMatchObject({ inFlight: 0, needsAttention: 2 });
    expect(job(createBulkMailJob(storage, input(2), expiresAt)).status).toBe("expired");
    expect(storage.writes).toBe(writes);
  });

  it("allows only one active job, keeps every nonce through TTL, and bounds owner storage", () => {
    const storage = new MemoryStorage();
    create(storage, 1);
    expect(createBulkMailJob(storage, input(1, crypto.randomUUID()), NOW)).toEqual({ ok: false, reason: "busy" });
    cancelBulkMailJob(storage, JOB_ID, NOW);
    for (let i = 1; i < BULK_MAIL_MAX_JOBS; i++) {
      const nextId = crypto.randomUUID();
      create(storage, 1, nextId);
      cancelBulkMailJob(storage, nextId, NOW);
    }
    expect(createBulkMailJob(storage, input(1, crypto.randomUUID()), NOW + 1)).toEqual({ ok: false, reason: "full" });
    expect(job(createBulkMailJob(storage, input(1), NOW + 1)).status).toBe("canceled");
    expect(storage.values.size).toBe(1 + BULK_MAIL_MAX_JOBS * 2);
    expect(createBulkMailJob(storage, input(1, crypto.randomUUID()), NOW + BULK_MAIL_TTL_MS).ok).toBe(true);
    expect(storage.values.size).toBe(3);
    expect(getBulkMailJob(storage, JOB_ID, NOW + BULK_MAIL_TTL_MS)).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses corrupt stored pages rather than treating lost progress as pending", () => {
    const storage = new MemoryStorage();
    create(storage);
    storage.values.delete(`${BULK_MAIL_STORAGE_PREFIX}${JOB_ID}:page:0`);
    expect(getBulkMailJob(storage, JOB_ID, NOW)).toEqual({ ok: false, reason: "invalid-storage" });
    expect(createBulkMailJob(storage, input(), NOW)).toEqual({ ok: false, reason: "invalid-storage" });
    expect(claimBulkMailJob(storage, JOB_ID, NOW)).toEqual({ ok: false, reason: "invalid-storage" });
  });

  it("refuses a corrupt retention index and malformed status/claim/cancel RPC arguments", () => {
    const storage = new MemoryStorage();
    storage.values.set(`${BULK_MAIL_STORAGE_PREFIX}index`, [{ jobId: JOB_ID }]);
    expect(createBulkMailJob(storage, input(), NOW)).toEqual({ ok: false, reason: "invalid-storage" });
    expect(storage.writes).toBe(0);
    expect(getBulkMailJob(storage, JOB_ID, NOW, -1)).toEqual({ ok: false, reason: "invalid" });
    expect(getBulkMailJob(storage, JOB_ID, NOW, 0, 101)).toEqual({ ok: false, reason: "invalid" });
    expect(claimBulkMailJob(storage, "bad", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(cancelBulkMailJob(storage, JOB_ID, Number.NaN)).toEqual({ ok: false, reason: "invalid" });
  });
});

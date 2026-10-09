// Owner-local progress for an explicitly confirmed move. This module performs
// no mail work and has no runtime imports. A claim is durably recorded before
// its caller can act. Abandoned claims are uncertain, never replayable.

export const BULK_MAIL_MAX_ENTRIES = 1000;
export const BULK_MAIL_CLAIM_MAX = 25;
export const BULK_MAIL_CLAIM_MS = 35_000;
export const BULK_MAIL_TTL_MS = 24 * 60 * 60 * 1000;
export const BULK_MAIL_MAX_JOBS = 8;
export const BULK_MAIL_STORAGE_PREFIX = "mail-bulk:v1:";
const INDEX_KEY = `${BULK_MAIL_STORAGE_PREFIX}index`;
// Even the longest allowed old and new ids fit below one KV value's bound.
const PAGE_SIZE = 10;
const MAX_ID_CHARS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]+$/;

export interface BulkMailStorage {
  get<T = unknown>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
}

export interface BulkMailEntry {
  readonly i: number;
  readonly z: number;
  readonly d: number;
  readonly n: string;
}

export interface BulkMailScope {
  readonly sourceFolderId: string;
  readonly uidValidity: number;
  readonly destinationFolderId: string;
  readonly destinationRole: "archive" | "trash" | null;
}

export interface BulkMailCreateInput extends BulkMailScope {
  /** The nonce of the verified, signed confirmation, never a newly minted id. */
  readonly jobId: string;
  readonly entries: readonly BulkMailEntry[];
  readonly ids: readonly string[];
}

export type BulkMailOutcomeCode = "moved" | "copied_not_removed" | "not_copied" | "unknown";
export const BULK_MAIL_RESULT_REASONS = [
  "verified-gone", "copy-refused", "copy-unproven", "changed-since-preview",
  "mark-refused", "removal-refused", "still-in-source", "verify-refused",
  "verify-unanswered", "connection-lost", "stopped-for-time", "not-attempted",
  "removal-not-kept", "commands-unavailable", "mailbox-read-only",
] as const;
export type BulkMailResultReason = (typeof BULK_MAIL_RESULT_REASONS)[number];
export type BulkMailStoredReason = BulkMailResultReason | "claim-expired" | "result-missing";

export interface BulkMailResultInput {
  readonly index: number;
  readonly outcome: BulkMailOutcomeCode;
  readonly reason: BulkMailResultReason;
  /** Only supplied when the move returned evidence identifying its copy. */
  readonly newId: string | null;
}

export interface BulkMailResult {
  readonly outcome: BulkMailOutcomeCode;
  readonly reason: BulkMailStoredReason;
  readonly newId: string | null;
}

export type BulkMailEntryState = "pending" | "in_flight" | "moved" | "needs_attention";
export type BulkMailJobStatus = "pending" | "running" | "completed" | "needs_attention" | "canceled" | "expired";
export interface BulkMailCounts {
  readonly total: number;
  readonly pending: number;
  readonly inFlight: number;
  readonly moved: number;
  readonly needsAttention: number;
}

export interface BulkMailEntryView {
  readonly index: number;
  readonly id: string;
  readonly state: BulkMailEntryState;
  readonly result: BulkMailResult | null;
}

export interface BulkMailJobView extends BulkMailScope {
  readonly jobId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly canceledAt: number | null;
  readonly status: BulkMailJobStatus;
  readonly counts: BulkMailCounts;
  /** A stable slice of the original ordered set, with no raw fingerprints. */
  readonly entries: readonly BulkMailEntryView[];
  readonly nextOffset: number | null;
}

export type BulkMailRefusal = "invalid" | "invalid-storage" | "not-found" | "scope-mismatch" | "busy" | "full" | "expired" | "canceled" | "stale-claim";
export interface BulkMailFailure {
  readonly ok: false;
  readonly reason: BulkMailRefusal;
}
export type BulkMailJobAnswer = { readonly ok: true; readonly job: BulkMailJobView } | BulkMailFailure;
export type BulkMailCreateAnswer = { readonly ok: true; readonly job: BulkMailJobView; readonly existing: boolean } | BulkMailFailure;
export interface BulkMailClaim {
  readonly token: string;
  readonly expiresAt: number;
  readonly entries: readonly { readonly index: number; readonly id: string; readonly entry: BulkMailEntry }[];
}
export type BulkMailClaimAnswer = {
  readonly ok: true;
  readonly job: BulkMailJobView;
  readonly scope: BulkMailScope;
  readonly claim: BulkMailClaim | null;
} | BulkMailFailure;

interface StoredEntry {
  id: string;
  entry: BulkMailEntry;
  state: BulkMailEntryState;
  result: BulkMailResult | null;
}
interface StoredClaim {
  token: string;
  expiresAt: number;
  indices: number[];
}
interface Header extends BulkMailScope {
  v: 1;
  jobId: string;
  createdAt: number;
  expiresAt: number;
  canceledAt: number | null;
  total: number;
  claim: StoredClaim | null;
}
interface Job { header: Header; entries: StoredEntry[] }
interface IndexItem { jobId: string; expiresAt: number; total: number }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function whole(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && OPAQUE_ID.test(value);
}
export function isBulkMailJobId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function time(value: unknown): value is number {
  return whole(value, 0, Number.MAX_SAFE_INTEGER - BULK_MAIL_TTL_MS);
}
function scopeOf(value: Record<string, unknown>): BulkMailScope | null {
  if (!id(value.sourceFolderId) || !id(value.destinationFolderId) ||
      value.sourceFolderId === value.destinationFolderId || !whole(value.uidValidity, 1, 0xffffffff) ||
      (value.destinationRole !== null && value.destinationRole !== "archive" && value.destinationRole !== "trash")) return null;
  return {
    sourceFolderId: value.sourceFolderId, uidValidity: value.uidValidity,
    destinationFolderId: value.destinationFolderId, destinationRole: value.destinationRole,
  };
}
function entryOf(value: unknown): BulkMailEntry | null {
  if (!object(value) || !exact(value, ["i", "z", "d", "n"]) ||
      !whole(value.i, 1, 0xffffffff) || !whole(value.z, 0) || !whole(value.d, 0) ||
      typeof value.n !== "string" || !/^[0-9]{1,20}$/.test(value.n)) return null;
  return { i: value.i, z: value.z, d: value.d, n: value.n };
}

/** Strict RPC input parser; copies known fields and never retains extra data. */
export function parseBulkMailCreateInput(value: unknown): BulkMailCreateInput | null {
  if (!object(value) || !exact(value, ["jobId", "sourceFolderId", "uidValidity", "destinationFolderId", "destinationRole", "entries", "ids"]) ||
      !isBulkMailJobId(value.jobId) || !Array.isArray(value.entries) || !Array.isArray(value.ids) ||
      value.entries.length < 1 || value.entries.length > BULK_MAIL_MAX_ENTRIES || value.ids.length !== value.entries.length) return null;
  const scope = scopeOf(value);
  if (scope === null) return null;
  const entries: BulkMailEntry[] = [];
  const ids: string[] = [];
  const seenUids = new Set<number>();
  const seenIds = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = entryOf(value.entries[index]);
    const messageId: unknown = value.ids[index];
    if (entry === null || !id(messageId) || seenUids.has(entry.i) || seenIds.has(messageId)) return null;
    seenUids.add(entry.i);
    seenIds.add(messageId);
    entries.push(entry);
    ids.push(messageId);
  }
  return { jobId: value.jobId, ...scope, entries, ids };
}

/** A closed outcome vocabulary, with only explicit unattempted work retryable. */
export function parseBulkMailResults(value: unknown): BulkMailResultInput[] | null {
  if (!Array.isArray(value) || value.length > BULK_MAIL_CLAIM_MAX) return null;
  const out: BulkMailResultInput[] = [];
  const seen = new Set<number>();
  for (const one of value) {
    if (!object(one) || !exact(one, ["index", "outcome", "reason", "newId"]) ||
        !whole(one.index, 0, BULK_MAIL_MAX_ENTRIES - 1) || seen.has(one.index) ||
        (one.outcome !== "moved" && one.outcome !== "copied_not_removed" && one.outcome !== "not_copied" && one.outcome !== "unknown") ||
        typeof one.reason !== "string" || !(BULK_MAIL_RESULT_REASONS as readonly string[]).includes(one.reason) ||
        (one.newId !== null && !id(one.newId))) return null;
    if (one.outcome === "moved" && (one.reason !== "verified-gone" || one.newId === null)) return null;
    if (one.outcome !== "moved" && one.reason === "verified-gone") return null;
    if (one.outcome === "not_copied" && one.newId !== null) return null;
    if (one.reason === "not-attempted" && one.outcome !== "not_copied") return null;
    seen.add(one.index);
    out.push({ index: one.index, outcome: one.outcome, reason: one.reason as BulkMailResultReason, newId: one.newId });
  }
  return out;
}

function headerKey(jobId: string): string { return `${BULK_MAIL_STORAGE_PREFIX}${jobId}:header`; }
function pageKey(jobId: string, page: number): string { return `${BULK_MAIL_STORAGE_PREFIX}${jobId}:page:${page}`; }
function fail(reason: BulkMailRefusal): BulkMailFailure { return { ok: false, reason }; }
function indexOf(storage: BulkMailStorage): IndexItem[] | null {
  const raw = storage.get<unknown>(INDEX_KEY);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > BULK_MAIL_MAX_JOBS) return null;
  const seen = new Set<string>();
  for (const one of raw) {
    if (!object(one) || !exact(one, ["jobId", "expiresAt", "total"]) || !isBulkMailJobId(one.jobId) ||
        !time(one.expiresAt) || !whole(one.total, 1, BULK_MAIL_MAX_ENTRIES) || seen.has(one.jobId)) return null;
    seen.add(one.jobId);
  }
  return structuredClone(raw) as IndexItem[];
}

/** Stored records are not an RPC surface; corrupt data fails closed. */
function load(storage: BulkMailStorage, jobId: string): Job | BulkMailFailure {
  const raw = storage.get<unknown>(headerKey(jobId));
  if (raw === undefined) return fail("not-found");
  if (!object(raw) || raw.v !== 1 || raw.jobId !== jobId || scopeOf(raw) === null ||
      !time(raw.createdAt) || !time(raw.expiresAt) || raw.expiresAt !== raw.createdAt + BULK_MAIL_TTL_MS ||
      (raw.canceledAt !== null && (!time(raw.canceledAt) || raw.canceledAt < raw.createdAt || raw.canceledAt >= raw.expiresAt)) ||
      !whole(raw.total, 1, BULK_MAIL_MAX_ENTRIES)) return fail("invalid-storage");
  const entries: StoredEntry[] = [];
  for (let page = 0; page < Math.ceil(raw.total / PAGE_SIZE); page++) {
    const rows = storage.get<unknown>(pageKey(jobId, page));
    const length = Math.min(PAGE_SIZE, raw.total - page * PAGE_SIZE);
    if (!Array.isArray(rows) || rows.length !== length) return fail("invalid-storage");
    for (const one of rows) {
      if (!object(one) || !id(one.id) || entryOf(one.entry) === null ||
          !["pending", "in_flight", "moved", "needs_attention"].includes(String(one.state))) return fail("invalid-storage");
      if (one.state === "pending" || one.state === "in_flight") {
        if (one.result !== null) return fail("invalid-storage");
      } else {
        if (!object(one.result)) return fail("invalid-storage");
        const reason = one.result.reason;
        const internal = reason === "claim-expired" || reason === "result-missing";
        if (internal) {
          if (one.result.outcome !== "unknown" || one.result.newId !== null) return fail("invalid-storage");
        } else if (parseBulkMailResults([{ index: 0, ...one.result }]) === null) return fail("invalid-storage");
        if ((one.state === "moved") !== (one.result.outcome === "moved")) return fail("invalid-storage");
      }
      entries.push(structuredClone(one) as unknown as StoredEntry);
    }
  }
  if (raw.claim !== null) {
    if (!object(raw.claim) || !isBulkMailJobId(raw.claim.token) || !time(raw.claim.expiresAt) ||
        raw.claim.expiresAt > raw.expiresAt || !Array.isArray(raw.claim.indices) ||
        raw.claim.indices.length < 1 || raw.claim.indices.length > BULK_MAIL_CLAIM_MAX ||
        new Set(raw.claim.indices).size !== raw.claim.indices.length ||
        !raw.claim.indices.every((i) => whole(i, 0, entries.length - 1) && entries[i].state === "in_flight")) return fail("invalid-storage");
  }
  const inFlight = entries.flatMap((one, index) => one.state === "in_flight" ? [index] : []);
  if (inFlight.length !== (raw.claim === null ? 0 : (raw.claim as unknown as StoredClaim).indices.length)) return fail("invalid-storage");
  return { header: structuredClone(raw) as unknown as Header, entries };
}

function persist(storage: BulkMailStorage, job: Job, changed?: readonly number[]): void {
  const pages = changed === undefined
    ? Array.from({ length: Math.ceil(job.entries.length / PAGE_SIZE) }, (_, page) => page)
    : [...new Set(changed.map((index) => Math.floor(index / PAGE_SIZE)))];
  for (const page of pages) {
    storage.put(pageKey(job.header.jobId, page), job.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
  }
  storage.put(headerKey(job.header.jobId), job.header);
}

/** Recovery is projected for read-only status, persisted before another claim. */
function recover(job: Job, now: number): number[] {
  const claim = job.header.claim;
  if (claim === null || claim.expiresAt > now) return [];
  for (const index of claim.indices) {
    job.entries[index].state = "needs_attention";
    job.entries[index].result = { outcome: "unknown", reason: "claim-expired", newId: null };
  }
  job.header.claim = null;
  return claim.indices;
}
function scope(job: Job): BulkMailScope {
  const h = job.header;
  return { sourceFolderId: h.sourceFolderId, uidValidity: h.uidValidity, destinationFolderId: h.destinationFolderId, destinationRole: h.destinationRole };
}
function view(job: Job, now: number, offset = 0, limit = 100): BulkMailJobView {
  recover(job, now);
  const counts = { total: job.entries.length, pending: 0, inFlight: 0, moved: 0, needsAttention: 0 };
  for (const one of job.entries) {
    if (one.state === "pending") counts.pending++;
    else if (one.state === "in_flight") counts.inFlight++;
    else if (one.state === "moved") counts.moved++;
    else counts.needsAttention++;
  }
  const h = job.header;
  const status: BulkMailJobStatus = now >= h.expiresAt ? "expired"
    : h.canceledAt !== null ? "canceled"
    : counts.inFlight > 0 ? "running"
    : counts.pending > 0 ? "pending"
    : counts.needsAttention > 0 ? "needs_attention" : "completed";
  return {
    jobId: h.jobId, ...scope(job), createdAt: h.createdAt, expiresAt: h.expiresAt, canceledAt: h.canceledAt,
    status, counts,
    entries: job.entries.slice(offset, offset + limit).map((one, index) => ({ index: offset + index, id: one.id, state: one.state, result: one.result === null ? null : { ...one.result } })),
    nextOffset: offset + limit < counts.total ? offset + limit : null,
  };
}
function sameScope(job: Job, input: BulkMailCreateInput): boolean {
  const h = job.header;
  return h.sourceFolderId === input.sourceFolderId && h.uidValidity === input.uidValidity &&
    h.destinationFolderId === input.destinationFolderId && h.destinationRole === input.destinationRole &&
    job.entries.length === input.entries.length && job.entries.every((one, index) => {
      const expected = input.entries[index];
      return one.id === input.ids[index] && one.entry.i === expected.i && one.entry.z === expected.z && one.entry.d === expected.d && one.entry.n === expected.n;
    });
}

/** Caller verifies the confirmation before calling; this atomically consumes its nonce. */
export function createBulkMailJob(storage: BulkMailStorage, value: unknown, now: number): BulkMailCreateAnswer {
  const input = parseBulkMailCreateInput(value);
  if (input === null || !time(now)) return fail("invalid");
  const existing = load(storage, input.jobId);
  if ("header" in existing) {
    if (!sameScope(existing, input)) return fail("scope-mismatch");
    return { ok: true, existing: true, job: view(existing, now) };
  }
  if (existing.reason !== "not-found") return existing;
  const index = indexOf(storage);
  if (index === null) return fail("invalid-storage");
  const retained = index.filter((one) => one.expiresAt > now);
  for (const one of retained) {
    const job = load(storage, one.jobId);
    if (!("header" in job)) return fail("invalid-storage");
    if (job.header.total !== one.total || job.header.expiresAt !== one.expiresAt) return fail("invalid-storage");
    recover(job, now);
    if (job.header.claim !== null || (job.header.canceledAt === null && job.entries.some((entry) => entry.state === "pending"))) return fail("busy");
  }
  if (retained.length >= BULK_MAIL_MAX_JOBS) return fail("full");
  // Completed nonces are retained for the whole TTL; capacity never evicts one.
  for (const old of index.filter((one) => one.expiresAt <= now)) {
    storage.delete(headerKey(old.jobId));
    for (let page = 0; page < Math.ceil(old.total / PAGE_SIZE); page++) storage.delete(pageKey(old.jobId, page));
  }
  const header: Header = { v: 1, jobId: input.jobId, ...scopeOf(input as unknown as Record<string, unknown>)!, createdAt: now, expiresAt: now + BULK_MAIL_TTL_MS, canceledAt: null, total: input.entries.length, claim: null };
  const job: Job = { header, entries: input.entries.map((entry, i) => ({ id: input.ids[i], entry, state: "pending", result: null })) };
  persist(storage, job);
  storage.put(INDEX_KEY, [...retained, { jobId: header.jobId, expiresAt: header.expiresAt, total: header.total }]);
  return { ok: true, existing: false, job: view(job, now) };
}

export function getBulkMailJob(storage: BulkMailStorage, jobId: unknown, now: number, offset = 0, limit = 100): BulkMailJobAnswer {
  if (!isBulkMailJobId(jobId) || !time(now) || !whole(offset, 0, BULK_MAIL_MAX_ENTRIES) || !whole(limit, 1, 100)) return fail("invalid");
  const job = load(storage, jobId);
  return "header" in job ? { ok: true, job: view(job, now, offset, limit) } : job;
}

export function claimBulkMailJob(storage: BulkMailStorage, jobId: unknown, now: number): BulkMailClaimAnswer {
  if (!isBulkMailJobId(jobId) || !time(now)) return fail("invalid");
  const job = load(storage, jobId);
  if (!("header" in job)) return job;
  if (now >= job.header.expiresAt) return fail("expired");
  if (job.header.canceledAt !== null) return fail("canceled");
  const changed = recover(job, now);
  if (job.header.claim !== null) return fail("busy");
  const indices: number[] = [];
  for (let i = 0; i < job.entries.length && indices.length < BULK_MAIL_CLAIM_MAX; i++) {
    if (job.entries[i].state === "pending") indices.push(i);
  }
  if (indices.length === 0) {
    if (changed.length > 0) persist(storage, job, changed);
    return { ok: true, job: view(job, now), scope: scope(job), claim: null };
  }
  const token = crypto.randomUUID();
  const expiresAt = Math.min(now + BULK_MAIL_CLAIM_MS, job.header.expiresAt);
  for (const i of indices) job.entries[i].state = "in_flight";
  job.header.claim = { token, expiresAt, indices };
  persist(storage, job, [...changed, ...indices]);
  return { ok: true, job: view(job, now), scope: scope(job), claim: { token, expiresAt, entries: indices.map((index) => ({ index, id: job.entries[index].id, entry: { ...job.entries[index].entry } })) } };
}

export function finishBulkMailJob(storage: BulkMailStorage, jobId: unknown, token: unknown, value: unknown, now: number): BulkMailJobAnswer {
  const results = parseBulkMailResults(value);
  if (!isBulkMailJobId(jobId) || !isBulkMailJobId(token) || !time(now) || results === null) return fail("invalid");
  const job = load(storage, jobId);
  if (!("header" in job)) return job;
  if (now >= job.header.expiresAt) return fail("expired");
  const claim = job.header.claim;
  if (claim === null || claim.token !== token || claim.expiresAt <= now) return fail("stale-claim");
  if (results.some((one) => !claim.indices.includes(one.index))) return fail("invalid");
  const byIndex = new Map(results.map((one) => [one.index, one]));
  for (const index of claim.indices) {
    const result = byIndex.get(index);
    const one = job.entries[index];
    if (result?.outcome === "not_copied" && result.reason === "not-attempted") {
      one.state = "pending";
      one.result = null;
    } else {
      one.state = result?.outcome === "moved" ? "moved" : "needs_attention";
      one.result = result === undefined ? { outcome: "unknown", reason: "result-missing", newId: null }
        : { outcome: result.outcome, reason: result.reason, newId: result.newId };
    }
  }
  job.header.claim = null;
  persist(storage, job, claim.indices);
  return { ok: true, job: view(job, now) };
}

/** Pending work freezes; an existing unexpired claim may still report its outcome. */
export function cancelBulkMailJob(storage: BulkMailStorage, jobId: unknown, now: number): BulkMailJobAnswer {
  if (!isBulkMailJobId(jobId) || !time(now)) return fail("invalid");
  const job = load(storage, jobId);
  if (!("header" in job)) return job;
  if (now >= job.header.expiresAt) return fail("expired");
  if (job.header.canceledAt === null) {
    const changed = recover(job, now);
    job.header.canceledAt = now;
    persist(storage, job, changed);
  }
  return { ok: true, job: view(job, now) };
}

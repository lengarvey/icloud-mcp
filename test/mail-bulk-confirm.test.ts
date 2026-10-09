// The larger preview scope has its own signed target. The ordinary mail
// confirmation and per-session move bounds remain unchanged.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BULK_MAIL_CONFIRM_SET_MAX,
  CONFIRM_VERSION,
  ConfirmationInvalidError,
  MAIL_CONFIRM_SET_MAX,
  mintConfirmation,
  verifyConfirmation,
} from "../src/confirm";
import type { ConfirmPayload, ConfirmTarget, MailBulkConfirmPayload } from "../src/confirm";
import { MOVE_SET_CAP } from "../src/mail/triage";
import { TOKEN_ENCODER, toBase64Url } from "../src/tokens";

const SECRET = "bulk-confirm-test-signing-key-not-real";
const USER = "1".repeat(64);
const OTHER_USER = "2".repeat(64);
const NOW = 1_800_000_000;

afterEach(() => vi.restoreAllMocks());

function payload(count = 26): MailBulkConfirmPayload {
  return {
    v: CONFIRM_VERSION,
    t: "mail-bulk",
    k: "move",
    j: "bulk-preview-test-one-time-id",
    u: USER,
    x: NOW + 300,
    h: "the-immutable-preview-scope-hash",
    m: "the-source-folder-token",
    uv: 12345,
    q: "the-destination-folder-token",
    qr: null,
    l: Array.from({ length: count }, (_, index) => ({
      i: index + 1,
      z: 800 + index,
      d: NOW - 1000 - index,
      n: "4611686018427387905",
    })),
  };
}

async function verify(
  built: unknown,
  expected: ConfirmTarget = "mail-bulk",
  user = USER,
) {
  const token = await mintConfirmation(built as ConfirmPayload, SECRET);
  return verifyConfirmation(token, SECRET, user, expected);
}

describe("the caller-driven bulk move confirmation", () => {
  it.each([1, 25, 26, 1000])("round-trips an exact scope of %i messages", async (count) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const built = payload(count);
    expect(await verify(built)).toEqual(built);
    expect((await verify(built)).t).toBe("mail-bulk");
  });

  it("keeps the ordinary confirmation and execution bounds at 25", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    expect(MAIL_CONFIRM_SET_MAX).toBe(25);
    expect(MOVE_SET_CAP).toBe(25);
    expect(BULK_MAIL_CONFIRM_SET_MAX).toBe(1000);
    const normal = { ...payload(25), t: "mail" };
    expect(await verify(normal, "mail")).toEqual(normal);
    await expect(verify({ ...payload(26), t: "mail" }, "mail")).rejects.toBeInstanceOf(
      ConfirmationInvalidError,
    );
  });

  it.each([0, 1001])("refuses a scope of %i messages", async (count) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    await expect(verify(payload(count))).rejects.toBeInstanceOf(ConfirmationInvalidError);
  });

  it("refuses ordinary mail and bulk tokens at each other's commit boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    await expect(verify(payload(1), "mail")).rejects.toBeInstanceOf(ConfirmationInvalidError);
    await expect(verify({ ...payload(1), t: "mail" })).rejects.toBeInstanceOf(
      ConfirmationInvalidError,
    );
    for (const target of ["dav", "col", "rule"] as const) {
      await expect(verify(payload(1), target)).rejects.toBeInstanceOf(ConfirmationInvalidError);
    }
  });

  it.each(["create", "update", "delete", "reply", "rule"])(
    "refuses the non-move kind %s",
    async (kind) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
      await expect(verify({ ...payload(), k: kind })).rejects.toBeInstanceOf(
        ConfirmationInvalidError,
      );
    },
  );

  it("binds the scope to the signed-in owner and the preview expiry", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    await expect(verify(payload(), "mail-bulk", OTHER_USER)).rejects.toBeInstanceOf(
      ConfirmationInvalidError,
    );
    const built = payload();
    clock.mockReturnValue((built.x - 1) * 1000);
    expect(await verify(built)).toEqual(built);
    clock.mockReturnValue(built.x * 1000);
    await expect(verify(built)).rejects.toBeInstanceOf(ConfirmationInvalidError);
  });

  it("keeps each exact UID and fingerprint, and rejects duplicate UIDs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const built = payload();
    const roundTrip = await verifyConfirmation(
      await mintConfirmation(built, SECRET), SECRET, USER, "mail-bulk",
    );
    expect(roundTrip.l).toEqual(built.l);
    expect(roundTrip.l[0]!.n).toBe("4611686018427387905");
    await expect(verify({ ...built, l: [built.l[0], built.l[0]] })).rejects.toBeInstanceOf(
      ConfirmationInvalidError,
    );
  });

  it.each([undefined, null, 742, "", "7.42e2", " 742 "])(
    "refuses a missing or malformed fingerprint change number %s",
    async (number) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
      const built = payload(1);
      await expect(verify({ ...built, l: [{ ...built.l[0], n: number }] })).rejects.toBeInstanceOf(
        ConfirmationInvalidError,
      );
    },
  );

  it.each(["m", "uv", "q", "qr", "l"])("refuses a scope missing %s", async (field) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const built: Record<string, unknown> = { ...payload() };
    delete built[field];
    await expect(verify(built)).rejects.toBeInstanceOf(ConfirmationInvalidError);
  });

  it.each(["c", "o", "r", "e", "s", "b", "f", "g"])(
    "refuses an unrelated target field %s",
    async (field) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
      await expect(verify({ ...payload(), [field]: "x" })).rejects.toBeInstanceOf(
        ConfirmationInvalidError,
      );
    },
  );

  it("rejects a relabelled token even when its original mail signature is retained", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const original = { ...payload(1), t: "mail" as const };
    const token = await mintConfirmation(original, SECRET);
    const mac = token.split(".")[1]!;
    const relabelled = toBase64Url(TOKEN_ENCODER.encode(JSON.stringify({
      ...original, t: "mail-bulk",
    })));
    await expect(verifyConfirmation(`${relabelled}.${mac}`, SECRET, USER, "mail-bulk"))
      .rejects.toBeInstanceOf(ConfirmationInvalidError);
  });
});

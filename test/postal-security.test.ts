import { describe, expect, it } from "vitest";
import PostalMime, { decodeWords } from "postal-mime";

describe("patched mail parser resource boundaries", () => {
  it("decodes a long run of joinable RFC 2047 words without losing bytes", async () => {
    // GHSA-f2hq-32vh-53cc: the patched decoder tracks the last word rather
    // than repeatedly flattening the entire accumulated header. Keep a real
    // repeated-word input, not a mocked decoder or a version-only assertion.
    const words = "=?utf-8?B?QUJD?=".repeat(40_000);
    const expected = "ABC".repeat(40_000);
    expect(decodeWords(words)).toBe(expected);
    const parsed = await PostalMime.parse(`Subject: ${words}\r\n\r\nbody`);
    expect(parsed.subject).toBe(expected);
  });

  it("counts inline message headers against the outer header budget", async () => {
    const outer = ["Content-Type: message/rfc822", `X-Pad: ${"x".repeat(250)}`].join("\r\n");
    const inner = `Subject: ${"x".repeat(250)}\r\n\r\ninner body`;
    // Each block fits alone; only the combined parse exceeds the budget.
    await expect(PostalMime.parse(`${outer}\r\n\r\n`, { maxHeadersSize: 512 })).resolves.toBeDefined();
    await expect(PostalMime.parse(inner, { maxHeadersSize: 512 })).resolves.toBeDefined();
    const raw = `${outer}\r\n\r\n${inner}`;
    await expect(PostalMime.parse(raw, { maxHeadersSize: 512 })).rejects.toMatchObject({
      code: "EMAXHEADERSIZE",
    });
  });
});

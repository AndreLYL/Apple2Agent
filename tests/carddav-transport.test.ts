import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDAVFetch } from "../src/adapters/carddav.js";

test("frontdoor transport preserves the resource, conditional write, and payload in one request", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await cardDAVFetch(
    AbortSignal.timeout(1000),
    true,
    fake,
  )("https://p225-contacts.icloud.com/account/card/card.vcf", {
    method: "PUT",
    headers: { "If-Match": '"revision-1"' },
    body: "frozen-vcard",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://contacts.icloud.com/account/card/card.vcf",
  );
  assert.equal(calls[0]!.init?.method, "PUT");
  assert.equal(
    new Headers(calls[0]!.init?.headers).get("If-Match"),
    '"revision-1"',
  );
  assert.equal(calls[0]!.init?.body, "frozen-vcard");
});

test("a failed contacts mutation is never retried on the discovered host", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    throw new TypeError("connection reset after write");
  }) as typeof fetch;
  await assert.rejects(
    cardDAVFetch(
      AbortSignal.timeout(1000),
      true,
      fake,
    )("https://p225-contacts.icloud.com/account/card/card.vcf", {
      method: "DELETE",
    }),
  );
  assert.equal(calls, 1);
});

test("contacts frontdoor routing preserves the China region and rejects non-Apple destinations", async () => {
  const urls: string[] = [];
  const fake = (async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const request = cardDAVFetch(AbortSignal.timeout(1000), true, fake);
  await request("https://p12-contacts.icloud.com.cn/account/card/");
  assert.deepEqual(urls, ["https://contacts.icloud.com.cn/account/card/"]);
  await assert.rejects(
    request("https://p12-contacts.icloud.com.evil.example/account/card/"),
  );
  assert.equal(urls.length, 1);
});

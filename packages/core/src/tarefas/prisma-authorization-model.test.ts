import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { parsePrismaConsent, prismaConsentReturn, PRISMA_REDIRECT, rememberPrismaConsent, restorePrismaConsent } from "./prisma-authorization-model.ts";
const params = new URLSearchParams({ client_id: "prisma", redirect_uri: PRISMA_REDIRECT, response_type: "code", code_challenge_method: "S256", code_challenge: "a".repeat(43), state: "b".repeat(64), email: "person@example.test" });
describe("Prisma consent", () => {
  test("requires exact client, redirect and S256", () => {
    assert.ok(parsePrismaConsent(params.toString()));
    for (const [field, value] of [["redirect_uri", "https://evil.test"], ["client_id", "evil"], ["code_challenge_method", "plain"], ["state", "short"], ["code_challenge", "short"]]) {
      const changed = new URLSearchParams(params); changed.set(field!, value!);
      assert.equal(parsePrismaConsent(changed.toString()), null);
    }
  });
  test("cancel and code use only fixed destination and fragment", () => {
    const returned = new URL(prismaConsentReturn("b".repeat(64), { error: "access_denied" }));
    assert.equal(returned.origin + returned.pathname, PRISMA_REDIRECT);
    assert.equal(returned.search, "");
    assert.ok(returned.hash.includes("error=access_denied"));
    assert.ok(prismaConsentReturn("b".repeat(64), { code: "c".repeat(64) }).includes("#foco-callback?"));
  });
  test("Microsoft login resumes consent once, with expiry and no arbitrary destination", () => {
    const values = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => { values.set(k,v); }, getItem: (k: string) => values.get(k) ?? null, removeItem: (k: string) => { values.delete(k); } };
    rememberPrismaConsent(params.toString(), storage, 1000);
    assert.ok(parsePrismaConsent(restorePrismaConsent("", storage, 1001)));
    assert.equal(restorePrismaConsent("", storage, 1001), "");
    rememberPrismaConsent(params.toString(), storage, 1000);
    assert.equal(restorePrismaConsent("", storage, 400000), "");
    rememberPrismaConsent("?redirect_uri=https://evil.test", storage, 1000);
    assert.equal(values.size,0);
  });
});

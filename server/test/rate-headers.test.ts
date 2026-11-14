import { test } from "node:test";
import assert from "node:assert/strict";

// Every answer carries the tenant's requests a minute and what is left (x-ratelimit-limit-requests and
// x-ratelimit-remaining-requests), so a caller (bloom for business's site reader) paces itself instead of meeting 429s.
const { check, rateLeft } = await import("../src/router/limits.js");
type Tenant = Parameters<typeof check>[0];
type Key = Parameters<typeof check>[1];

test("rateLeft: the limit and what is left of this minute, after each request; null without a limit", () => {
  const tenant = { id: `t_rate_${Math.random()}`, name: "Rate test", status: "active", rpm_limit: 3, tpm_limit: 0, monthly_token_budget: 0, monthly_usd_budget: 0 } as unknown as Tenant;
  const key = { id: `k_${Math.random()}`, name: "k", rpm_limit: 0, monthly_token_budget: 0 } as unknown as Key;
  assert.deepEqual(rateLeft(tenant), { limit: 3, remaining: 3 });
  check(tenant, key);
  assert.deepEqual(rateLeft(tenant), { limit: 3, remaining: 2 });
  check(tenant, key);
  check(tenant, key);
  assert.deepEqual(rateLeft(tenant), { limit: 3, remaining: 0 });
  assert.throws(() => check(tenant, key), /limited to 3 requests a minute/);
  assert.equal(rateLeft({ ...tenant, rpm_limit: 0 } as Tenant), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProvisionCli } from "../scripts/provision-clinic-user.mjs";

const input = {
  mode: "invite",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "local@example.test",
  fullName: "Local fixture",
};
const secret = "sb_secret_DO_NOT_LOG_THIS_VALUE";
// Fixture represents the official SDK action_link, including verification type
// and provider query parameters that application code must preserve verbatim.
const link =
  "https://project.example.test/auth/v1/verify?token=DO_NOT_LOG_INVITE&type=invite&redirect_to=https%3A%2F%2Faperodashboard.lovable.app%2Faccount%2Fsetup&provider_parameter=retain";
const result = {
  clinicId: input.clinicId,
  authUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  profileId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  invitationUrl: link,
};
const profile = {
  id: result.profileId,
  auth_user_id: result.authUserId,
  clinic_id: input.clinicId,
};

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "apero-cli-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const member = join(dir, "member.json");
  const output = join(dir, "invitation.json");
  await writeFile(member, JSON.stringify(input));
  const calls = [];
  const messages = [];
  const issuedLinks = [];
  let currentToken = null;
  let consumed = false;
  // Model non-current/consumed tokens separately from elapsed expiration.
  // Mock time never advances, so otp_expired below cannot mean time expiry.
  const verifyInvitation = (invitationUrl) => {
    const token = new URL(invitationUrl).searchParams.get("token");
    if (token !== currentToken || consumed) return { status: 403, error_code: "otp_expired" };
    consumed = true;
    return { status: 200 };
  };
  let storedProfile = options.existingProfile ?? null;
  const run = async (extra = [], overrides = {}) => {
    const code = await runProvisionCli(
      ["--input", member, "--portal-origin", "https://aperodashboard.lovable.app", ...extra],
      {
        env: { SUPABASE_URL: "https://project.example.test", SUPABASE_SECRET_KEY: secret },
        log: (line) => messages.push(line),
        errorLog: (line) => messages.push(line),
        fetcher: async (url, init) => {
          const req = new Request(url, init);
          const endpoint = new URL(req.url);
          assert.equal(
            endpoint.origin,
            "https://project.example.test",
            "external calls prohibited",
          );
          assert.equal(req.headers.get("apikey"), secret);
          assert.equal(req.headers.get("authorization"), null);
          assert.equal(init.redirect, "error");
          assert.ok(!endpoint.pathname.startsWith("/functions/"));
          calls.push({ path: endpoint.pathname, method: req.method });
          if (options.providerFailure)
            return Response.json({ message: `${secret} ${link}`, code: "42501" }, { status: 403 });
          if (endpoint.pathname === "/rest/v1/rpc/reserve_clinic_invitation") {
            if (
              options.invalidClinic ||
              (options.existingProfile && options.existingProfile.clinic_id !== input.clinicId)
            )
              return Response.json({ code: "invite_unavailable" });
            return Response.json({
              code: "ready",
              token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              clinic_id: input.clinicId,
              email: input.email,
            });
          }
          if (endpoint.pathname === "/rest/v1/rpc/finish_clinic_invitation")
            return Response.json(null);
          if (endpoint.pathname === "/rest/v1/clinics")
            return Response.json(options.invalidClinic ? [] : [{ id: input.clinicId }]);
          if (endpoint.pathname === "/auth/v1/admin/generate_link") {
            const body = await req.json();
            assert.equal(body.type, "invite");
            assert.equal(
              endpoint.searchParams.get("redirect_to"),
              "https://aperodashboard.lovable.app/account/setup",
            );
            assert.equal(body.email, input.email);
            if (options.inviteFailure)
              return Response.json({ msg: "Auth operation failed" }, { status: 500 });
            if (options.verified)
              return Response.json(
                { msg: "Account already verified", code: "email_exists" },
                { status: 400 },
              );
            currentToken = issuedLinks.length
              ? `DO_NOT_LOG_INVITE_${issuedLinks.length + 1}`
              : "DO_NOT_LOG_INVITE";
            consumed = false;
            const actionLink = options.secretInLink
              ? `https://example.test/${secret}`
              : link.replace("DO_NOT_LOG_INVITE", currentToken);
            issuedLinks.push(actionLink);
            return Response.json({
              id: result.authUserId,
              email: input.email,
              action_link: actionLink,
              verification_type: "invite",
            });
          }
          if (endpoint.pathname === `/auth/v1/admin/users/${result.authUserId}`)
            return Response.json({
              user: {
                id: result.authUserId,
                email: input.email,
                email_confirmed_at: options.unverified ? null : "2026-10-02T00:00:00Z",
              },
            });
          if (endpoint.pathname === "/rest/v1/profiles") {
            if (req.method === "POST") {
              assert.equal(storedProfile, null);
              const body = await req.json();
              assert.equal(body.clinic_id, input.clinicId);
              assert.equal(body.auth_user_id, result.authUserId);
              assert.equal(body.role, "staff");
              if (options.profileFailure)
                return Response.json(
                  { code: "23503", message: `${secret} ${link}` },
                  { status: 400 },
                );
              storedProfile = { ...profile, ...body };
              return new Response(null, { status: 201 });
            }
            assert.equal(endpoint.searchParams.get("auth_user_id"), `eq.${result.authUserId}`);
            return Response.json(storedProfile ? [storedProfile] : []);
          }
          throw new Error("Unexpected fixture endpoint");
        },
        ...overrides,
      },
    );
    for (const sensitive of [secret, link, "DO_NOT_LOG_INVITE", "DO_NOT_LOG_PASSWORD"])
      assert.ok(!messages.join("\n").includes(sensitive), "diagnostics must not leak secrets");
    return { code, text: messages.join("\n"), calls, storedProfile };
  };
  return { dir, member, output, run, issuedLinks, verifyInvitation };
}

test("direct local check validates credentials/output without creating files or network calls", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--check", "--output", f.output]);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  await assert.rejects(stat(f.output), { code: "ENOENT" });
});
test("new invite directly uses Auth Admin and verifies correct membership before private output", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--backend", "direct", "--execute", "--output", f.output]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), result);
  const official = new URL(JSON.parse(await readFile(f.output, "utf8")).invitationUrl);
  assert.equal(official.searchParams.get("type"), "invite");
  assert.equal(
    official.searchParams.get("redirect_to"),
    "https://aperodashboard.lovable.app/account/setup",
  );
  assert.equal(official.searchParams.get("provider_parameter"), "retain");
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(f.output, "utf8")).includes(secret));
  assert.equal(r.calls.at(-1).path, "/rest/v1/rpc/finish_clinic_invitation");
  assert.match(r.text, /Clinic membership verified/);
});
test("one new-user CLI command generates exactly one current token and saves its official action link", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--backend", "direct", "--execute", "--output", f.output]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, [
    { path: "/rest/v1/rpc/reserve_clinic_invitation", method: "POST" },
    { path: "/rest/v1/clinics", method: "GET" },
    { path: "/auth/v1/admin/generate_link", method: "POST" },
    { path: "/rest/v1/profiles", method: "GET" },
    { path: "/rest/v1/profiles", method: "POST" },
    { path: "/rest/v1/profiles", method: "GET" },
    { path: "/rest/v1/rpc/finish_clinic_invitation", method: "POST" },
  ]);
  assert.equal(f.issuedLinks.length, 1);
  // Include every Auth request, not just generate_link: a later /invite,
  // /resend or user mutation must not silently replace the captured token.
  assert.equal(r.calls.filter((call) => call.path.startsWith("/auth/")).length, 1);
  const saved = JSON.parse(await readFile(f.output, "utf8"));
  assert.ok(
    saved.invitationUrl === f.issuedLinks.at(-1),
    "save the final SDK action_link verbatim",
  );
  assert.equal(f.verifyInvitation(saved.invitationUrl).status, 200);
  assert.deepEqual(f.verifyInvitation(saved.invitationUrl), {
    status: 403,
    error_code: "otp_expired",
  });
});
test("a separate invite command replaces the previous token without elapsed expiry; latest output stays valid", async (t) => {
  const f = await fixture(t);
  const first = await f.run(["--execute", "--output", f.output]);
  const retryOutput = join(f.dir, "retry.json");
  const second = await f.run(["--execute", "--output", retryOutput]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(f.issuedLinks.length, 2);
  assert.equal(second.calls.filter((call) => call.path.startsWith("/auth/")).length, 2);
  const original = JSON.parse(await readFile(f.output, "utf8"));
  const latest = JSON.parse(await readFile(retryOutput, "utf8"));
  assert.ok(original.invitationUrl !== latest.invitationUrl, "each execution issues a new token");
  assert.deepEqual(f.verifyInvitation(original.invitationUrl), {
    status: 403,
    error_code: "otp_expired",
  });
  assert.ok(latest.invitationUrl === f.issuedLinks.at(-1), "latest output uses the current link");
  assert.equal(f.verifyInvitation(latest.invitationUrl).status, 200);
});
test("Auth generation failure is not automatically retried or replaced by another invitation call", async (t) => {
  const f = await fixture(t, { inviteFailure: true });
  const r = await f.run(["--execute", "--output", f.output]);
  assert.equal(r.code, 1);
  assert.deepEqual(
    r.calls.filter((call) => call.path.startsWith("/auth/")),
    [{ path: "/auth/v1/admin/generate_link", method: "POST" }],
  );
  assert.equal(f.issuedLinks.length, 0);
  assert.equal(await readFile(f.output, "utf8"), "");
});
for (const [name, mutation, expected] of [
  ["missing input", async (f) => rm(f.member), /stage=input-read; code=ENOENT/],
  [
    "malformed JSON",
    async (f) => writeFile(f.member, '{"password":"DO_NOT_LOG_PASSWORD"'),
    /stage=input-json/,
  ],
  [
    "invalid schema",
    async (f) => writeFile(f.member, JSON.stringify({ ...input, password: "DO_NOT_LOG_PASSWORD" })),
    /stage=input-validation/,
  ],
])
  test(`${name} is safely diagnosed before network calls`, async (t) => {
    const f = await fixture(t);
    await mutation(f);
    const r = await f.run(["--execute", "--output", f.output]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.text, expected);
    await assert.rejects(stat(f.output), { code: "ENOENT" });
  });
test("missing modern secret never falls back to legacy credentials", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--execute", "--output", f.output], {
    env: { SUPABASE_URL: "https://project.example.test", SUPABASE_SERVICE_ROLE_KEY: secret },
  });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /MISSING_ENV/);
  assert.match(r.text, /SUPABASE_SECRET_KEY/);
  await assert.rejects(stat(f.output), { code: "ENOENT" });
});
test("missing URL and secret are explicitly reported", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--check"], { env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /SUPABASE_URL, SUPABASE_SECRET_KEY/);
  assert.equal(r.calls.length, 0);
});
test("invalid URLs, publishable keys and malformed secrets are rejected locally", async (t) => {
  for (const env of [
    { SUPABASE_URL: `https://user:${secret}@example.test`, SUPABASE_SECRET_KEY: secret },
    { SUPABASE_URL: secret, SUPABASE_SECRET_KEY: secret },
    { SUPABASE_URL: "https://project.example.test", SUPABASE_SECRET_KEY: `${secret}\n` },
    { SUPABASE_URL: "https://project.example.test", SUPABASE_SECRET_KEY: "sb_publishable_fixture" },
  ]) {
    const f = await fixture(t);
    const r = await f.run(["--check"], { env });
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.text, /INVALID_SUPABASE_URL|INVALID_OPERATOR_KEY/);
  }
});
test("missing output directory is explicit and makes no request", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--execute", "--output", join(f.dir, "absent", "invite.json")]);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /stage=output-check; code=ENOENT/);
});
test("existing output is never overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(f.output, "retain");
  const r = await f.run(["--execute", "--output", f.output]);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /EEXIST/);
  assert.equal(await readFile(f.output, "utf8"), "retain");
});
test("deprecated Edge backend cannot accidentally provision", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["--backend", "edge", "--execute", "--output", f.output]);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /DIRECT_BACKEND_REQUIRED/);
});
test("invalid arguments and portal origin are blocked before requests", async (t) => {
  const f = await fixture(t);
  assert.match((await f.run(["--execute"])).text, /stage=arguments/);
  assert.match((await f.run(["--check", "--execute"])).text, /stage=arguments/);
  assert.match(
    (await f.run(["--check", "--portal-origin", `https://user:${secret}@example.test`])).text,
    /stage=portal-origin/,
  );
});
for (const [name, options, message] of [
  ["invalid clinic", { invalidClinic: true }, /Invitation unavailable/],
  ["verified account invite", { verified: true }, /Existing accounts require explicit association/],
  [
    "cross-clinic profile",
    { existingProfile: { ...profile, clinic_id: result.profileId } },
    /Invitation unavailable/,
  ],
  [
    "failed profile creation",
    { profileFailure: true },
    new RegExp(`Inspect Auth account ${result.authUserId}`),
  ],
  [
    "provider failure with secret-bearing body",
    { providerFailure: true },
    /Invitation unavailable/,
  ],
  ["secret-bearing result", { secretInLink: true }, /UNSAFE_RESULT/],
])
  test(`${name} withholds invitation and exposes no credential`, async (t) => {
    const f = await fixture(t, options);
    const r = await f.run(["--execute", "--output", f.output]);
    assert.equal(r.code, 1);
    assert.equal(await readFile(f.output, "utf8"), "");
    assert.match(r.text, message);
    if (options.invalidClinic) assert.ok(!r.calls.some((c) => c.path.startsWith("/auth/")));
    if (options.existingProfile)
      assert.ok(!r.calls.some((c) => c.method !== "GET" && c.path === "/rest/v1/profiles"));
    if (options.profileFailure) {
      assert.equal(f.issuedLinks.length, 1);
      assert.equal(r.calls.filter((call) => call.path.startsWith("/auth/")).length, 1);
    }
  });
test("retry keeps one profile and preserves existing details and role", async (t) => {
  const existing = { ...profile, role: "owner", full_name: "Existing name" };
  const f = await fixture(t, { existingProfile: existing });
  const first = await f.run(["--execute", "--output", f.output]);
  const second = await f.run(["--execute", "--output", join(f.dir, "retry.json")]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(second.storedProfile, existing);
  assert.ok(!second.calls.some((c) => c.method !== "GET" && c.path === "/rest/v1/profiles"));
});
test("existing verified account is explicitly associated without generating another invite", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.member,
    JSON.stringify({ ...input, mode: "associate", authUserId: result.authUserId }),
  );
  const r = await f.run(["--execute", "--output", f.output]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(await readFile(f.output, "utf8")).invitationUrl, null);
  assert.ok(!r.calls.some((c) => c.path.endsWith("generate_link")));
});
test("unverified existing account cannot be associated", async (t) => {
  const f = await fixture(t, { unverified: true });
  await writeFile(
    f.member,
    JSON.stringify({ ...input, mode: "associate", authUserId: result.authUserId }),
  );
  const r = await f.run(["--execute", "--output", f.output]);
  assert.equal(r.code, 1);
  assert.match(r.text, /Existing verified Auth account does not match/);
  assert.equal(await readFile(f.output, "utf8"), "");
});

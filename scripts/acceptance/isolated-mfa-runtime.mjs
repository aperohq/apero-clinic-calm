// Actual standalone Supabase Auth, disposable native PostgreSQL, no-egress namespace.
// This certifies provider API behavior, not Apero UI or hosted production acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { disposablePostgres, command } from "../helpers/disposable-postgres.mjs";

const evidenceDir = resolve("docs/release/2026-11-24/evidence");
const resultPath = join(evidenceDir, "mfa-runtime.json");
const binary = process.env.APERO_AUTH_BINARY ?? "/tmp/apero-mfa-tools/auth";
const toolsRoot = resolve(binary, "..");
const expectedArchive = "4abe9134d7615faa9149cab514acada8e7133cd69d2ccd96fdcef0d795c05171";

function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(char);
    assert(n >= 0, "Invalid synthetic base32");
    bits += n.toString(2).padStart(5, "0");
  }
  return Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
      parseInt(bits.slice(i * 8, i * 8 + 8), 2),
    ),
  );
}
function totp(secret, seconds = Date.now() / 1000) {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const hash = createHmac("sha1", base32(secret)).update(count).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
function claims(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
}
function sign(claim, secret) {
  const input = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claim)).toString("base64url"),
  ].join(".");
  return input + "." + createHmac("sha256", secret).update(input).digest("base64url");
}

if (!process.argv.includes("--inner")) {
  await rm(resultPath, { force: true });
  const archive = await readFile(join(toolsRoot, "auth.tar.xz"));
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    expectedArchive,
    "Official archive digest mismatch",
  );
  let cluster,
    success = false;
  try {
    cluster = await disposablePostgres({ database: "apero_mfa_acceptance" });
    const sql = postgres({ ...cluster, max: 1, onnotice() {} });
    await sql.unsafe(
      'create role postgres nologin;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls; create schema auth; create extension if not exists pgcrypto; create extension if not exists "uuid-ossp";alter role apero_test set search_path=auth,public;',
    );
    await sql.end();
    const clusterArgs = JSON.stringify({
      host: cluster.host,
      port: cluster.port,
      database: cluster.database,
      username: cluster.username,
    });
    await command("unshare", [
      "--user",
      "--map-root-user",
      "--net",
      "/bin/sh",
      "-c",
      'ip link set lo up && exec "$@"',
      "mfa-local",
      process.execPath,
      resolve(process.argv[1]),
      "--inner",
      clusterArgs,
    ]);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    success = result.status === "PASS";
    assert(success, "Standalone MFA checks did not pass");
  } finally {
    if (cluster) {
      await cluster.close(true);
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      result.cleanup.postgresql_stopped = true;
      try {
        await access(join(cluster.host, `.s.PGSQL.${cluster.port}`));
        result.cleanup.postgresql_socket_removed = false;
      } catch {
        result.cleanup.postgresql_socket_removed = true;
      }
      try {
        await access(cluster.root);
        result.cleanup.synthetic_cluster_removed = false;
      } catch {
        result.cleanup.synthetic_cluster_removed = true;
      }
      await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
    }
  }
  console.log(JSON.stringify({ result: success ? "PASS" : "FAIL", evidence: resultPath }));
} else {
  const cluster = JSON.parse(process.argv.at(-1));
  assert(
    cluster.host.startsWith("/dev/shm/apero-native-") &&
      cluster.database === "apero_mfa_acceptance",
  );
  const sql = postgres({ ...cluster, max: 2, onnotice() {} });
  const privateDir = await mkdtemp("/dev/shm/apero-mfa-secrets-");
  const jwtSecret = randomBytes(48).toString("hex");
  const password = randomBytes(32).toString("base64url") + "Aa9!";
  const email = "isolated-mfa@example.test";
  const apiPort = 39997;
  const api = `http://127.0.0.1:${apiPort}`;
  const state = {
    started_at: new Date().toISOString(),
    status: "RUNNING",
    provider: "supabase/auth",
    version: "v2.198.0",
    archive_sha256: expectedArchive,
    environment:
      "Standalone native Auth API and PostgreSQL; user/network namespace, loopback only, no default routes",
    tests: [],
    external_writes: 0,
    production_writes: 0,
    smtp_connections: 0,
    cleanup: {},
  };
  let auth, userId;
  const smtp = createServer((socket) => {
    state.smtp_connections++;
    socket.destroy();
  });
  await new Promise((resolve) => smtp.listen(39998, "127.0.0.1", resolve));
  const save = () => writeFile(resultPath, JSON.stringify(state, null, 2) + "\n");
  async function check(id, ok, details = {}) {
    state.tests.push({ id, status: ok ? "PASS" : "FAIL", ...details });
    await save();
    assert(ok, id);
  }
  async function request(path, { body, token, method = body ? "POST" : "GET" } = {}) {
    assert(path.startsWith("/") && !path.startsWith("//"));
    const response = await fetch(api + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }
  const admin = sign(
    {
      role: "service_role",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    jwtSecret,
  );
  try {
    const routes = await command("ip", ["route", "show"]);
    await check("MFA-NETWORK-ISOLATION", routes.trim() === "", { external_routes: 0 });
    const env = {
      PATH: process.env.PATH,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? "",
      GOTRUE_DB_DRIVER: "postgres",
      DATABASE_URL: `postgres://${cluster.username}@/${cluster.database}?host=${encodeURIComponent(cluster.host)}&port=${cluster.port}&sslmode=disable`,
      DB_NAMESPACE: "auth",
      GOTRUE_API_HOST: "127.0.0.1",
      PORT: String(apiPort),
      API_EXTERNAL_URL: api,
      GOTRUE_SITE_URL: api,
      GOTRUE_JWT_SECRET: jwtSecret,
      GOTRUE_JWT_EXP: "3600",
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
      GOTRUE_MAILER_AUTOCONFIRM: "false",
      GOTRUE_SMTP_HOST: "127.0.0.1",
      GOTRUE_SMTP_PORT: "39998",
      GOTRUE_SMTP_ADMIN_EMAIL: "mailer@example.test",
      GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true",
      GOTRUE_MFA_TOTP_VERIFY_ENABLED: "true",
      GOTRUE_MFA_PHONE_ENROLL_ENABLED: "false",
      GOTRUE_MFA_PHONE_VERIFY_ENABLED: "false",
      GOTRUE_LOG_LEVEL: "error",
    };
    let migrateLog = "";
    const migrate = spawn(binary, ["migrate"], {
      cwd: toolsRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    migrate.stdout.on("data", (data) => {
      migrateLog += data.toString();
    });
    migrate.stderr.on("data", (data) => {
      migrateLog += data.toString();
    });
    const migrationExit = await new Promise((resolve) => migrate.once("close", resolve));
    if (migrationExit !== 0)
      state.migration_diagnostic = migrateLog
        .replaceAll(jwtSecret, "[REDACTED]")
        .replaceAll(password, "[REDACTED]")
        .replaceAll(admin, "[REDACTED]")
        .slice(-1600);
    await check("MFA-AUTH-MIGRATIONS", migrationExit === 0, { exit_code: migrationExit });
    const migrated = await sql`select count(*)::int n from auth.schema_migrations`;
    state.auth_migrations = migrated[0].n;
    // Logs remain in memory for startup classification only; never serialize sensitive lines.
    let errorLog = "";
    auth = spawn(binary, ["serve"], { cwd: toolsRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    auth.stdout.on("data", (data) => {
      errorLog += data.toString();
    });
    auth.stderr.on("data", (data) => {
      errorLog += data.toString();
    });
    let health;
    for (let i = 0; i < 100; i++) {
      try {
        health = await request("/health");
        if (health.status === 200) break;
      } catch {}
      if (auth.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (health?.status !== 200) {
      const names = [
        ...errorLog.matchAll(/(?:required key|missing.*configuration)[^\n]{0,100}/gi),
      ].map((x) => x[0].replace(/"[^\"]*"/g, '"redacted"'));
      state.startup = {
        exit_code: auth.exitCode,
        required_config_hints: names,
        migration_error: /migration|migrat/i.test(errorLog),
        database_error: /database|connect|sql/i.test(errorLog),
      };
      throw new Error("AuthStartupFailed");
    }
    errorLog = "";
    await check("MFA-AUTH-HEALTH", health.status === 200, { http: health.status });
    const listeners = (await command("ss", ["-lntH"])).trim().split("\n").filter(Boolean);
    await check(
      "MFA-LOOPBACK-LISTENERS",
      listeners.length === 2 &&
        listeners.every((line) => line.split(/\s+/)[3].startsWith("127.0.0.1:")),
      { tcp_listeners: listeners.length, loopback_only: true },
    );
    const create = await request("/admin/users", {
      token: admin,
      body: { email, password, email_confirm: true },
    });
    if (create.status !== 200)
      state.provider_diagnostic = {
        api_error_code: create.data?.code,
        sqlstate: errorLog.match(/SQLSTATE [0-9A-Z]{5}/)?.[0],
        missing_relation: errorLog.match(/relation \\?"([A-Za-z_.]+)\\?" does not exist/)?.[1],
      };
    await check("MFA-SYNTHETIC-USER", create.status === 200 && Boolean(create.data?.id), {
      http: create.status,
    });
    userId = create.data.id;
    let login = await request("/token?grant_type=password", { body: { email, password } });
    await check(
      "MFA-PASSWORD-AAL1",
      login.status === 200 && claims(login.data.access_token).aal === "aal1",
      { http: login.status },
    );
    let session = login.data;
    const enroll = await request("/factors", {
      token: session.access_token,
      body: { factor_type: "totp", friendly_name: "Synthetic primary" },
    });
    await check(
      "MFA-PRIMARY-ENROLL",
      enroll.status === 200 && enroll.data?.type === "totp" && Boolean(enroll.data?.totp?.secret),
      { http: enroll.status },
    );
    const primary = enroll.data;
    let challenge = await request(`/factors/${primary.id}/challenge`, {
      token: session.access_token,
      body: {},
    });
    let bad = "000000";
    const accepted = [-30, 0, 30].map((offset) =>
      totp(primary.totp.secret, Date.now() / 1000 + offset),
    );
    while (accepted.includes(bad)) bad = String((Number(bad) + 1) % 1000000).padStart(6, "0");
    const invalid = await request(`/factors/${primary.id}/verify`, {
      token: session.access_token,
      body: { challenge_id: challenge.data.id, code: bad },
    });
    await check(
      "MFA-INVALID-CODE-DENIED",
      invalid.status === 422 && invalid.data?.error_code === "mfa_verification_failed",
      { http: invalid.status, error_code: invalid.data?.error_code },
    );
    challenge = await request(`/factors/${primary.id}/challenge`, {
      token: session.access_token,
      body: {},
    });
    await sql`update auth.mfa_challenges set created_at=now()-interval '10 minutes' where id=${challenge.data.id}`;
    const expired = await request(`/factors/${primary.id}/verify`, {
      token: session.access_token,
      body: { challenge_id: challenge.data.id, code: totp(primary.totp.secret) },
    });
    await check(
      "MFA-EXPIRED-CHALLENGE-DENIED",
      expired.status === 422 && expired.data?.error_code === "mfa_challenge_expired",
      {
        http: expired.status,
        error_code: expired.data?.error_code,
        expiry_fixture: "Only isolated challenge created_at backdated; server policy unchanged",
      },
    );
    challenge = await request(`/factors/${primary.id}/challenge`, {
      token: session.access_token,
      body: {},
    });
    const verified = await request(`/factors/${primary.id}/verify`, {
      token: session.access_token,
      body: { challenge_id: challenge.data.id, code: totp(primary.totp.secret) },
    });
    await check(
      "MFA-PRIMARY-VERIFY-AAL2",
      verified.status === 200 && claims(verified.data.access_token).aal === "aal2",
      { http: verified.status },
    );
    session = verified.data;
    const replay = await request(`/factors/${primary.id}/verify`, {
      token: session.access_token,
      body: { challenge_id: challenge.data.id, code: totp(primary.totp.secret) },
    });
    await check("MFA-VERIFIED-CHALLENGE-REPLAY-DENIED", replay.status === 422, {
      http: replay.status,
      error_code: replay.data?.error_code,
    });
    const backup = await request("/factors", {
      token: session.access_token,
      body: { factor_type: "totp", friendly_name: "Synthetic backup" },
    });
    await check("MFA-BACKUP-ENROLL", backup.status === 200 && Boolean(backup.data?.totp?.secret), {
      http: backup.status,
    });
    challenge = await request(`/factors/${backup.data.id}/challenge`, {
      token: session.access_token,
      body: {},
    });
    const backupVerified = await request(`/factors/${backup.data.id}/verify`, {
      token: session.access_token,
      body: { challenge_id: challenge.data.id, code: totp(backup.data.totp.secret) },
    });
    await check(
      "MFA-BACKUP-VERIFY-AAL2",
      backupVerified.status === 200 && claims(backupVerified.data.access_token).aal === "aal2",
      { http: backupVerified.status },
    );
    session = backupVerified.data;
    const list = await request("/user", { token: session.access_token });
    await check(
      "MFA-TWO-VERIFIED-FACTORS",
      list.status === 200 &&
        list.data?.factors?.filter((f) => f.status === "verified").length === 2,
      { http: list.status },
    );
    login = await request("/token?grant_type=password", { body: { email, password } });
    await check(
      "MFA-SUBSEQUENT-LOGIN-AAL1",
      login.status === 200 && claims(login.data.access_token).aal === "aal1",
      { http: login.status },
    );
    const aal1 = login.data;
    const denied = await request(`/factors/${primary.id}`, {
      token: aal1.access_token,
      method: "DELETE",
    });
    await check("MFA-AAL1-CANNOT-REMOVE-FACTOR", denied.status === 403 || denied.status === 422, {
      http: denied.status,
      error_code: denied.data?.error_code,
    });
    // Wait for the normal TOTP interval rather than weakening anti-replay or clock-skew rules.
    await new Promise((resolve) => setTimeout(resolve, 30200 - (Date.now() % 30000)));
    challenge = await request(`/factors/${backup.data.id}/challenge`, {
      token: aal1.access_token,
      body: {},
    });
    const recovered = await request(`/factors/${backup.data.id}/verify`, {
      token: aal1.access_token,
      body: { challenge_id: challenge.data.id, code: totp(backup.data.totp.secret) },
    });
    await check(
      "MFA-LOST-PRIMARY-BACKUP-STEPUP",
      recovered.status === 200 && claims(recovered.data.access_token).aal === "aal2",
      {
        http: recovered.status,
        recovery_scope:
          "Pre-enrolled backup-factor provider mechanism; no business recovery policy claimed",
      },
    );
    session = recovered.data;
    const removed = await request(`/factors/${primary.id}`, {
      token: session.access_token,
      method: "DELETE",
    });
    await check("MFA-RECOVERED-USER-REMOVES-LOST-PRIMARY", removed.status === 200, {
      http: removed.status,
    });
    const remaining = await request("/user", { token: session.access_token });
    await check(
      "MFA-BACKUP-REMAINS-VERIFIED",
      remaining.status === 200 &&
        remaining.data?.factors?.filter((f) => f.status === "verified").length === 1,
      { http: remaining.status },
    );
    const logout = await request("/logout?scope=local", { token: session.access_token, body: {} });
    const refresh = await request("/token?grant_type=refresh_token", {
      body: { refresh_token: session.refresh_token },
    });
    await check(
      "MFA-SESSION-LOCAL-LOGOUT-REFRESH-DENIED",
      logout.status === 204 && refresh.status === 400,
      { logout_http: logout.status, refresh_http: refresh.status },
    );
    await check("MFA-NO-MAIL-OR-SMS", state.smtp_connections === 0, {
      smtp_connections: state.smtp_connections,
      sms_provider_configured: false,
    });
    state.status = "PASS";
  } catch (error) {
    state.status = "FAIL";
    state.error_class = error.name;
    state.failed_scenario =
      state.tests.find((x) => x.status === "FAIL")?.id ?? "startup_or_harness";
  } finally {
    if (userId && auth?.exitCode === null) {
      try {
        const deleted = await request(`/admin/users/${userId}`, { token: admin, method: "DELETE" });
        state.cleanup.synthetic_user_deleted = deleted.status === 200;
      } catch {
        state.cleanup.synthetic_user_deleted = false;
      }
    }
    try {
      const rows =
        await sql`select (select count(*) from auth.users)::int users,(select count(*) from auth.mfa_factors)::int factors,(select count(*) from auth.sessions)::int sessions`;
      state.cleanup.remaining = rows[0];
    } catch {
      state.cleanup.remaining = "unavailable";
    }
    if (auth?.exitCode === null) {
      auth.kill("SIGTERM");
      await new Promise((resolve) => auth.once("close", resolve));
    }
    state.cleanup.auth_process_stopped =
      !auth || auth.exitCode !== null || auth.signalCode !== null;
    if (auth) {
      try {
        process.kill(auth.pid, 0);
        state.cleanup.auth_pid_absent = false;
      } catch (error) {
        state.cleanup.auth_pid_absent = error.code === "ESRCH";
      }
    }
    await new Promise((resolve) => smtp.close(resolve));
    await sql.end({ timeout: 2 });
    await rm(privateDir, { recursive: true, force: true });
    state.cleanup.private_tmpfs_removed = true;
    state.finished_at = new Date().toISOString();
    await save();
  }
  console.log(
    JSON.stringify({
      status: state.status,
      pass: state.tests.filter((x) => x.status === "PASS").length,
      fail: state.tests.filter((x) => x.status === "FAIL").length,
      failed_scenario: state.failed_scenario,
      startup: state.startup,
    }),
  );
  if (state.status !== "PASS") process.exitCode = 1;
}

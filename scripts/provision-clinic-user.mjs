// Operator-only Node 24 tool; --check is local. --execute contacts Supabase.
import { readFile, open, access, lstat, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ProvisionDiagnosticError } from "./clinic-user-operator-config.mjs";
import { createClinicUserAdmin } from "./clinic-user-admin.server.mjs";
import {
  parseClinicUserRequest,
  invitationRedirect,
  provisionClinicUser,
  ClinicUserProvisionError,
} from "../src/lib/clinic-users.server.ts";

const stageMessages = {
  arguments:
    "Provide --input, --portal-origin, a valid --backend, and exactly one of --check or --execute. Execution requires --output.",
  "input-read": "Cannot read the input JSON file. Check its path and permissions.",
  "input-json": "Input file is not valid JSON.",
  "input-validation":
    "Invalid input fields. Use mode, clinicId (UUID), email, fullName; authUserId (UUID) is required only for associate mode. Extra fields are rejected.",
  "portal-origin":
    "Invalid --portal-origin. Use an HTTPS origin without credentials, path, query, or fragment.",
  "output-check":
    "Cannot use the output path. Its parent must exist and be writable; the output file must not already exist.",
  "output-open":
    "Cannot reserve the private output file. Its parent must exist and be writable; the output file must not already exist.",
  provisioning:
    "Provisioning failed. Inspect Auth/profile state before retrying; no output invitation was written.",
  "output-write":
    "Cannot write the verified result. Inspect Auth/profile state before retrying; the reserved output file may be empty or incomplete.",
  "output-close": "Cannot close the output file. Check the private file before retrying.",
};

async function checkOutputPath(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(resolve(path));
    if (!(await stat(parent)).isDirectory())
      throw new ProvisionDiagnosticError("ENOTDIR", "Output parent must be a directory.");
    await access(parent, constants.W_OK | constants.X_OK);
    return;
  }
  throw new ProvisionDiagnosticError(
    "EEXIST",
    "Output already exists. Use a new private filename; invitations are never overwritten.",
  );
}

// Injectable transport/environment for local tests; importing never executes.
export async function runProvisionCli(
  args,
  { env = process.env, fetcher = fetch, log = console.log, errorLog = console.error } = {},
) {
  let output;
  let admin;
  let stage = "arguments";
  let requestAttempted = false;
  let exitCode = 0;
  try {
    const { values } = parseArgs({
      args,
      options: {
        input: { type: "string" },
        output: { type: "string" },
        "portal-origin": { type: "string" },
        execute: { type: "boolean" },
        check: { type: "boolean" },
        help: { type: "boolean" },
        backend: { type: "string", default: "direct" },
      },
    });
    if (values.help) {
      log("Node 24: --input /private/member.json --portal-origin https://portal.example --check");
      log(
        "Authorized external provisioning only: replace --check with --execute --output /private/invitation.json",
      );
      log(
        "Production launch path: --backend direct (default). Edge provisioning is deprecated. --check validates locally without network calls; .env files are not automatically loaded.",
      );
      log(
        "Private operator credentials: exported SUPABASE_URL and SUPABASE_SECRET_KEY (sb_secret_ key).",
      );
    } else {
      if (
        !values.input ||
        !values["portal-origin"] ||
        Boolean(values.check) === Boolean(values.execute) ||
        (values.execute && !values.output)
      ) {
        throw new Error(
          "Provide --input, --portal-origin, and exactly one of --check or --execute.",
        );
      }
      if (values.backend !== "direct")
        throw new ProvisionDiagnosticError(
          "DIRECT_BACKEND_REQUIRED",
          "Use --backend direct. Edge provisioning is deprecated for production operator use.",
        );
      stage = "input-read";
      const text = await readFile(values.input, "utf8");
      stage = "input-json";
      const json = JSON.parse(text);
      stage = "input-validation";
      const input = parseClinicUserRequest(json);
      stage = "portal-origin";
      invitationRedirect(values["portal-origin"]);
      stage = "environment";
      // Stateless private client; creation/preflight makes no network calls.
      admin = createClinicUserAdmin(env, fetcher);
      stage = "output-check";
      if (values.output) await checkOutputPath(values.output);
      if (values.check) {
        log(
          "Local validation passed (input, portal origin, private operator environment, output path when supplied). No network calls or accounts created. Credentials were not authenticated remotely.",
        );
      } else {
        // Reserve an exclusive private file before external operations. Never
        // overwrite another invitation or print bearer links to the terminal.
        stage = "output-open";
        output = await open(values.output, "wx", 0o600);
        stage = "provisioning";
        requestAttempted = true;
        const result = await provisionClinicUser(admin, input, values["portal-origin"]);
        stage = "output-write";
        const serialized = JSON.stringify(result, null, 2) + "\n";
        if (serialized.includes(env.SUPABASE_SECRET_KEY))
          throw new ProvisionDiagnosticError(
            "UNSAFE_RESULT",
            "Result contains operator credentials; private result was withheld.",
            { endpoint: "operation attempted" },
          );
        await output.writeFile(serialized);
        stage = "output-close";
        await output.close();
        output = undefined;
        log("Clinic membership verified. Private result written to the requested file.");
      }
    }
  } catch (error) {
    // Do not print raw provider responses, credentials, or link-bearing errors.
    const fileCodes = new Set([
      "ENOENT",
      "EACCES",
      "EPERM",
      "EEXIST",
      "ENOTDIR",
      "EISDIR",
      "ENOSPC",
      "EROFS",
      "EMFILE",
    ]);
    const diagnostic = error instanceof ProvisionDiagnosticError;
    const code = diagnostic
      ? error.code
      : fileCodes.has(error?.code)
        ? error.code
        : "CLI_VALIDATION_OR_OPERATION_ERROR";
    errorLog(
      `Provisioning failed [stage=${stage}; code=${code}; HTTP=${diagnostic && error.status !== null ? error.status : "none"}; endpoint=${diagnostic ? error.endpoint : requestAttempted ? "unconfirmed (operation attempted)" : "not contacted"}].`,
    );
    errorLog(
      error instanceof ClinicUserProvisionError
        ? error.message
        : (stageMessages[stage] ?? "Local configuration validation failed."),
    );
    if (error instanceof ClinicUserProvisionError && error.authUserId) {
      errorLog(
        `Inspect Auth account ${error.authUserId} before retrying. No account was automatically deleted.`,
      );
    }
    if (output)
      errorLog(
        "A private output file was reserved; it may be empty or incomplete. Inspect account state and use a new output filename before retrying.",
      );
    exitCode = 1;
  } finally {
    await admin?.auth.dispose();
    try {
      await output?.close();
    } catch {
      errorLog(
        "Output close failed [code=OUTPUT_CLOSE_ERROR]. Check the private file before retrying.",
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runProvisionCli(process.argv.slice(2));

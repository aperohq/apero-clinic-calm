// Synthetic local databases only. Never accepts DATABASE_URL or a remote host.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
export const pgBinary = (name) =>
  process.env.APERO_TEST_PG_BIN ? join(process.env.APERO_TEST_PG_BIN, name) : name;
export async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${program} exited ${code}: ${stderr}`)),
    );
  });
}
export async function disposablePostgres({
  cron = false,
  database = "apero_native_validation",
} = {}) {
  if (process.platform === "win32")
    throw new Error(
      "Native full-chain validation runs on Linux; Windows components have a separate job.",
    );
  if (!/^apero_[a-z_]+$/.test(database)) throw new Error("Invalid disposable database name");
  await command(pgBinary("initdb"), ["--version"]);
  const root = await mkdtemp(join(tmpdir(), "apero-native-"));
  await mkdir(join(root, "socket"));
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  let started = false;
  async function stop() {
    if (started) {
      await command(pgBinary("pg_ctl"), [
        "-D",
        join(root, "data"),
        "-m",
        "immediate",
        "-w",
        "stop",
      ]);
      started = false;
    }
  }
  try {
    await command(pgBinary("initdb"), [
      "-D",
      join(root, "data"),
      "-U",
      "apero_test",
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    const config = `\nlisten_addresses = ''\nunix_socket_directories = '${join(root, "socket").replaceAll("'", "''")}'\nport = ${port}\n${cron ? `shared_preload_libraries = 'pg_cron'\ncron.database_name = '${database}'\ncron.use_background_workers = on\n` : ""}`;
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, "data", "postgresql.conf"), config);
    await command(pgBinary("pg_ctl"), [
      "-D",
      join(root, "data"),
      "-l",
      join(root, "server.log"),
      "-w",
      "start",
    ]);
    started = true;
    await command(pgBinary("createdb"), [
      "-h",
      join(root, "socket"),
      "-p",
      String(port),
      "-U",
      "apero_test",
      database,
    ]);
    await writeFile(join(root, ".apero-disposable.json"), JSON.stringify({ database, port }), {
      mode: 0o600,
    });
    return {
      root,
      port,
      database,
      host: join(root, "socket"),
      username: "apero_test",
      async close(success) {
        await stop();
        if (success) await rm(root, { recursive: true, force: true });
        else console.error("Isolated failure evidence:", root);
      },
    };
  } catch (error) {
    await stop();
    console.error("Isolated setup evidence:", root);
    throw error;
  }
}

import { createServer } from "node:net";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Give each unlinked temporary stack distinct host ports without dropping services.
 * Only numeric TOML port assignments change; hosted configuration is never read.
 * Docker performs the final bind. A concurrent host process can still win after
 * reservation, but unrelated stacks no longer systematically collide on defaults. */
export async function isolateSupabasePorts(config, allocate = availablePort) {
  const ports = new Set();
  const pattern = /^(\s*)([a-z_]*port)\s*=\s*\d+([ \t]*(?:#.*)?)$/gm;
  let result = "",
    cursor = 0;
  for (const match of config.matchAll(pattern)) {
    let port;
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = await allocate();
      if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535)
        throw new Error("Invalid local test port");
      if (!ports.has(candidate)) {
        port = candidate;
        break;
      }
    }
    if (!port) throw new Error("Could not allocate distinct local test ports");
    ports.add(port);
    result += config.slice(cursor, match.index) + `${match[1]}${match[2]} = ${port}${match[3]}`;
    cursor = match.index + match[0].length;
  }
  if (!ports.size) throw new Error("Supabase config has no numeric host ports");
  return { config: result + config.slice(cursor), ports: [...ports] };
}

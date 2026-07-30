#!/usr/bin/env node
/**
 * Runs a command with a Railway service's YouTube credentials in the
 * environment, so tests that need working OAuth can run locally without the
 * repository's revoked .env token.
 *
 *   node scripts/with-railway-youtube.mjs <service> -- <command...>
 *
 * Credentials are passed through the child's environment only — never printed.
 */
import { spawnSync } from "node:child_process";

const [service, sep, ...cmd] = process.argv.slice(2);
if (!service || sep !== "--" || cmd.length === 0) {
  console.error("usage: with-railway-youtube.mjs <service> -- <command...>");
  process.exit(2);
}

const res = spawnSync("railway", ["variables", "-s", service, "--json"], { encoding: "utf8" });
if (res.status !== 0) {
  console.error(`could not read Railway variables for ${service}; is the CLI linked?`);
  process.exit(1);
}

let vars;
try {
  vars = JSON.parse(res.stdout);
} catch {
  console.error("unexpected Railway CLI output");
  process.exit(1);
}

const env = { ...process.env };
for (const k of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]) {
  if (vars[k]) env[k] = vars[k];
}
console.log(`[with-railway-youtube] using ${service} credentials (values not printed)`);

const run = spawnSync("npx", cmd, { stdio: "inherit", env });
process.exit(run.status ?? 1);

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Shared regression suite: use only synthetic secrets and a fake CLI.
function fixture(t, { fail = "", files = { ".env": { path: "/", keys: ["APP_KEY"] } }, emptyTooling = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nsmbl-vault-failures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  copyFileSync(new URL("./vault.mjs", import.meta.url), path.join(root, "scripts/vault.mjs"));
  const authModule = new URL("./lib/vault-auth.mjs", import.meta.url);
  if (existsSync(authModule)) {
    mkdirSync(path.join(root, "scripts/lib"));
    copyFileSync(authModule, path.join(root, "scripts/lib/vault-auth.mjs"));
  }
  writeFileSync(path.join(root, ".infisical.json"), JSON.stringify({ workspaceId: "app-project" }));
  writeFileSync(path.join(root, ".vault.json"), JSON.stringify({ env: "dev", runPath: "/", files, notes: [], tooling: { projectId: "tooling-project", path: "/" } }));
  writeFileSync(path.join(root, "bin/infisical"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const project = args.find(a => a.startsWith('--projectId='))?.slice(12);
const folder = args.find(a => a.startsWith('--path='))?.slice(7);
if (args[0] === '--version') { console.log('fake'); process.exit(0); }
if (args.some(a => a.startsWith('--token='))) { console.error('SENSITIVE_TOKEN_ARGUMENT'); process.exit(1); }
if (${JSON.stringify(fail)} === 'login' && args[0] === 'login') { console.error('SENSITIVE_FAILURE'); process.exit(1); }
if (args[0] === 'login') { console.log('synthetic-token'); process.exit(0); }
if (args[0] === 'export' && process.env.INFISICAL_TOKEN !== 'synthetic-token') { console.error('SENSITIVE_MISSING_TOKEN'); process.exit(1); }
if (${JSON.stringify(fail)} === project || (${JSON.stringify(fail)} === 'second-folder' && folder === '/second')) { console.error('SENSITIVE_FAILURE'); process.exit(1); }
console.log(JSON.stringify(project === 'tooling-project' ? (${emptyTooling} ? {} : { TOOL_KEY: 'synthetic-tool' }) : { APP_KEY: 'synthetic-app' }));
`, { mode: 0o700 });
  return {
    root,
    run(args, extra = {}) {
      return spawnSync(process.execPath, [path.join(root, "scripts/vault.mjs"), ...args], {
        cwd: root, encoding: "utf8", env: {
          PATH: `${path.join(root, "bin")}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root, INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "synthetic-id", INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "synthetic-secret", ...extra,
        },
      });
    },
  };
}

test("run refuses to launch a child after project, tooling, or authentication failure", t => {
  for (const fail of ["app-project", "tooling-project", "login"]) {
    const f = fixture(t, { fail });
    const r = f.run(["run", "--", process.execPath, "-e", "console.log('CHILD_STARTED')"]);
    assert.notEqual(r.status, 0, fail);
    assert.doesNotMatch(r.stdout + r.stderr, /CHILD_STARTED|SENSITIVE|synthetic-secret/);
    assert.match(r.stderr, /vault unavailable|authentication failed/i);
  }
});

test("run rejects an unexpectedly empty shared vault", t => {
  const f = fixture(t, { emptyTooling: true });
  const r = f.run(["run", "--", process.execPath, "-e", "console.log('CHILD_STARTED')"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CHILD_STARTED/);
  assert.match(r.stderr, /empty vault/);
});

test("strict pull leaves every existing file intact when a later source fails", t => {
  for (const fail of ["second-folder", "tooling-project"]) {
    const f = fixture(t, { fail, files: { ".env": { path: "/", keys: ["APP_KEY"] }, ".env.second": { path: "/second", keys: ["APP_KEY"] } } });
    writeFileSync(path.join(f.root, ".env"), "APP_KEY=previous\n");
    writeFileSync(path.join(f.root, ".env.second"), "APP_KEY=previous-second\n");
    const r = f.run(["pull", "--force", "--require-vault", "--shell"]);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), "APP_KEY=previous\n");
    assert.equal(readFileSync(path.join(f.root, ".env.second"), "utf8"), "APP_KEY=previous-second\n");
    assert.equal(existsSync(path.join(f.root, ".nsmbl/tooling.env.sh")), false);
    assert.doesNotMatch(r.stdout + r.stderr, /SENSITIVE|previous-second/);
  }
});

test("projects without runtime files still validate the project and shared vault", t => {
  for (const fail of ["app-project", "tooling-project"]) {
    const f = fixture(t, { fail, files: {} });
    assert.equal(f.run(["pull", "--require-vault"]).status, 3);
    assert.equal(f.run(["check"]).status, 1);
  }
});

test("check cannot report success using stale local keys after a vault failure", t => {
  for (const fail of ["app-project", "tooling-project"]) {
    const f = fixture(t, { fail });
    writeFileSync(path.join(f.root, ".env"), "APP_KEY=previous\n");
    const r = f.run(["check"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /SENSITIVE|previous/);
  }
});

test("successful commands preserve the project and tooling merge", t => {
  const f = fixture(t);
  const r = f.run(["run", "--", process.execPath, "-e", "console.log(JSON.stringify({app:process.env.APP_KEY,tool:process.env.TOOL_KEY}))"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { app: "synthetic-app", tool: "synthetic-tool" });
  assert.equal(f.run(["pull", "--force", "--require-vault"]).status, 0);
  assert.match(readFileSync(path.join(f.root, ".env"), "utf8"), /synthetic-app/);
});

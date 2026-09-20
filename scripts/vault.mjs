#!/usr/bin/env node
// Everything secret comes from the Infisical vault. Shared verbatim across NSMBL repos.
//
//   node scripts/vault.mjs pull [--force] [--shell]  write the env files in .vault.json; in a cloud VM
//                                                    (or with --shell) also export the tooling tokens
//                                                    (GH_TOKEN, VERCEL_TOKEN, …) into the login shell
//   node scripts/vault.mjs check                     which keys have a value where (never prints values)
//   node scripts/vault.mjs run -- <cmd>              run a command with the repo's secrets and the tooling
//                                                    tokens in its environment
//   node scripts/vault.mjs notes                     print the account notes (what CREDENTIALS.md used to hold)
//
// .infisical.json holds this repo's project id (not a secret). .vault.json maps
// each local env file to a vault folder and lists the key names it should
// carry, names the multi-line notes (CREDENTIALS_MD…), and points `tooling` at
// the shared project whose secrets are CLI tokens rather than app config.
//
// Authentication, in order: INFISICAL_TOKEN; INFISICAL_UNIVERSAL_AUTH_CLIENT_ID +
// _SECRET (a machine identity: Cursor Cloud, CI); otherwise the CLI's own
// `infisical login` session. Those two identity values are the only secrets a
// Cursor Cloud environment needs. With no vault access at all, `pull` falls
// back to process.env, then to the `<file>.example` value, so a Build without
// the identity still gets a usable file. A `<file>.example` value starting
// with REPLACE_ pins that key to the placeholder so dev stays inert.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV = { ...process.env, INFISICAL_DISABLE_UPDATE_CHECK: "true" };
const args = process.argv.slice(2);
const cmd = args[0];
const force = args.includes("--force");

const config = readJson(path.join(ROOT, ".vault.json"));
const projectId = readJson(path.join(ROOT, ".infisical.json"))?.workspaceId;
const vaultEnv = config?.env ?? "dev";
const files = config?.files ?? {};
const noteNames = config?.notes ?? [];
const tooling = config?.tooling ?? null;
// Repo-level keys that also belong in the login shell (a per-account
// CLOUDFLARE_API_TOKEN, say); they override the shared tooling tokens.
const shellKeys = config?.shellKeys ?? [];
const isNote = (k) => noteNames.some((n) => k === n || k.startsWith(`${n}_`));
const inCloudVm = process.platform === "linux" && os.userInfo().username === "ubuntu";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function cli(cliArgs) {
  return spawnSync("infisical", cliArgs, { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
let cachedToken;
function token() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.INFISICAL_TOKEN) return (cachedToken = process.env.INFISICAL_TOKEN);
  if (!process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID || !process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET) return (cachedToken = null);
  const r = cli(["login", "--method=universal-auth", "--plain", "--silent"]);
  if (r.status !== 0) throw new Error(`infisical universal-auth login failed: ${(r.stderr || "").trim()}`);
  return (cachedToken = r.stdout.trim());
}
function exportSecrets(pid, vaultPath) {
  const a = ["export", "--format=json", `--projectId=${pid}`, `--env=${vaultEnv}`, `--path=${vaultPath}`];
  const t = token();
  if (t) a.push(`--token=${t}`);
  const r = cli(a);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "infisical export failed").trim().split("\n")[0]);
  const parsed = JSON.parse(r.stdout);
  return Array.isArray(parsed) ? Object.fromEntries(parsed.map((s) => [s.key ?? s.Key, s.value ?? s.Value])) : parsed;
}
function vaultFor(pid, vaultPath) {
  if (!pid) return { vault: null, reason: "no project id" };
  if (spawnSync("infisical", ["--version"], { stdio: "ignore" }).status !== 0) return { vault: null, reason: "infisical CLI not installed" };
  try { return { vault: exportSecrets(pid, vaultPath), reason: null }; }
  catch (e) { return { vault: null, reason: token() ? e.message : `not logged in (${e.message})` }; }
}
function parseEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v[0] === v.at(-1) && `"'`.includes(v[0])) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const quote = (v) => (/[\s#"'\\$`]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v);
const shQuote = (v) => `'${v.replace(/'/g, `'\\''`)}'`;

function toolingSecrets() {
  if (!tooling?.projectId) return { vault: null, reason: "no tooling project in .vault.json" };
  return vaultFor(tooling.projectId, tooling.path ?? "/");
}

// The tooling tokens go into the login shell so gh, wrangler, vercel, railway
// and supabase are authenticated in every agent terminal. Written only inside
// a cloud VM (or with --shell): a laptop's CLIs keep their own logins.
function writeShellEnv(vault) {
  const dir = path.join(os.homedir(), ".nsmbl");
  const file = path.join(dir, "tooling.env.sh");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = ["# Written by scripts/vault.mjs from the Infisical tooling project. Do not commit or copy.",
    ...Object.entries(vault).filter(([k]) => !isNote(k)).map(([k, v]) => `export ${k}=${shQuote(v)}`), ""].join("\n");
  fs.writeFileSync(file, body, { mode: 0o600 });
  const line = `[ -f "$HOME/.nsmbl/tooling.env.sh" ] && . "$HOME/.nsmbl/tooling.env.sh" # nsmbl vault tooling`;
  for (const rc of [".bashrc", ".profile"]) {
    const p = path.join(os.homedir(), rc);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    if (!cur.includes("# nsmbl vault tooling")) fs.appendFileSync(p, `\n${line}\n`);
  }
  return Object.keys(vault).filter((k) => !isNote(k)).length;
}

if (!config) {
  console.error(".vault.json is missing");
  process.exit(2);
}

if (cmd === "notes") {
  if (!noteNames.length) { console.log("no notes in .vault.json"); process.exit(0); }
  const { vault, reason } = vaultFor(projectId, "/");
  if (!vault) { console.error(`vault unavailable: ${reason}`); process.exit(1); }
  for (const name of noteNames) {
    const parts = Object.keys(vault).filter((k) => k === name || k.startsWith(`${name}_`)).sort();
    if (!parts.length) { console.error(`${name}: not in the vault`); continue; }
    console.log(parts.map((k) => vault[k]).join(""));
  }
} else if (cmd === "pull") {
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(ROOT, rel);
    const vaultPath = typeof spec === "string" ? spec : spec.path;
    const keys = typeof spec === "string" ? [] : spec.keys ?? [];
    const existing = parseEnvFile(file);
    if (Object.keys(existing).length && !force) { console.log(`${rel}: exists, kept (use --force to overwrite)`); continue; }
    const { vault, reason } = vaultFor(projectId, vaultPath);
    const example = parseEnvFile(`${file}.example`);
    const merged = {};
    for (const k of new Set([...(vault ? Object.keys(vault) : []), ...keys, ...Object.keys(existing), ...Object.keys(example)])) {
      if (isNote(k)) continue;
      const pinned = example[k]?.startsWith("REPLACE_") ? example[k] : null;
      let v = pinned ?? vault?.[k] ?? process.env[k] ?? existing[k] ?? example[k];
      // A manifest key with no value anywhere is still written as `KEY=` so
      // `wrangler types` declares it on Env and the type gate passes without the vault.
      if ((v === undefined || v === "") && (keys.includes(k) || k in example)) v = "";
      if (v !== undefined) merged[k] = v;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = `# Written by scripts/vault.mjs from Infisical ${vaultEnv}${vaultPath} (${vault ? "vault" : `no vault: ${reason}; environment, previous and example values`}). Do not commit.\n`;
    fs.writeFileSync(file, header + Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n");
    console.log(`${rel}: ${Object.keys(merged).length} keys from ${vault ? "vault" : `fallbacks (${reason})`}`);
  }
  if ((tooling || shellKeys.length) && (inCloudVm || args.includes("--shell"))) {
    const { vault, reason } = tooling ? toolingSecrets() : { vault: {}, reason: null };
    if (vault) {
      const repoRoot = shellKeys.length ? vaultFor(projectId, "/").vault ?? {} : {};
      const extra = Object.fromEntries(shellKeys.filter((k) => repoRoot[k]).map((k) => [k, repoRoot[k]]));
      console.log(`tooling: ${writeShellEnv({ ...vault, ...extra })} tokens exported to ~/.nsmbl/tooling.env.sh (sourced by .bashrc/.profile)`);
    } else console.log(`tooling: skipped (${reason})`);
  }
} else if (cmd === "check") {
  let missing = 0;
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(ROOT, rel);
    const vaultPath = typeof spec === "string" ? spec : spec.path;
    const keys = typeof spec === "string" ? [] : spec.keys ?? [];
    const { vault, reason } = vaultFor(projectId, vaultPath);
    const local = parseEnvFile(file);
    console.log(`${rel}  (vault ${vaultEnv}${vaultPath}: ${vault ? `${Object.keys(vault).filter((k) => !isNote(k)).length} keys` : reason})`);
    for (const k of new Set([...keys, ...(vault ? Object.keys(vault) : [])])) {
      if (isNote(k)) continue;
      const where = [local[k] && "file", process.env[k] && "env", vault?.[k] && "vault"].filter(Boolean);
      if (!where.length) missing++;
      console.log(`  ${where.length ? "ok " : "-- "} ${k}${where.length ? `  (${where.join(", ")})` : "  MISSING"}`);
    }
  }
  if (tooling) {
    const { vault, reason } = toolingSecrets();
    console.log(`tooling  (vault ${vaultEnv}${tooling.path ?? "/"}: ${vault ? `${Object.keys(vault).length} tokens` : reason})`);
    for (const k of Object.keys(vault ?? {})) console.log(`  ok  ${k}  (vault${process.env[k] ? ", env" : ""})`);
  }
  process.exit(missing ? 1 : 0);
} else if (cmd === "run") {
  const sep = args.indexOf("--");
  const userCmd = sep >= 0 ? args.slice(sep + 1) : args.slice(1);
  const pathArg = args.find((a) => a.startsWith("--path="))?.slice(7) ?? config.runPath ?? "/";
  if (!userCmd.length) { console.error("usage: vault.mjs run [--path=/x] -- <cmd>"); process.exit(2); }
  const repo = vaultFor(projectId, pathArg);
  if (!repo.vault) { console.error(`vault unavailable: ${repo.reason}`); process.exit(1); }
  const tool = tooling ? toolingSecrets().vault ?? {} : {};
  const env = { ...process.env };
  for (const [k, v] of Object.entries({ ...tool, ...repo.vault })) if (!isNote(k) && env[k] === undefined) env[k] = v;
  const r = spawnSync(userCmd[0], userCmd.slice(1), { env, stdio: "inherit" });
  process.exit(r.status ?? 1);
} else {
  console.error("usage: vault.mjs pull [--force] [--shell] | check | run [--path=/x] -- <cmd> | notes");
  process.exit(2);
}

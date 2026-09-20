#!/usr/bin/env node
// Local env files from the Infisical vault. Shared verbatim across NSMBL repos.
//
//   node scripts/vault.mjs pull [--force]   write each file in .vault.json from the vault
//   node scripts/vault.mjs check            which keys have a value where (never prints values)
//   node scripts/vault.mjs run -- <cmd>     run a command with the vault's secrets in its env
//   node scripts/vault.mjs notes            print the account notes (what CREDENTIALS.md used to hold)
//
// .infisical.json holds the project id (not a secret). .vault.json maps each
// local env file to a vault folder and lists the key names it should carry;
// its `notes` array names the multi-line secrets (CREDENTIALS_MD…) that hold
// account logins, where each key was issued and how to rotate it.
// Authentication, in order: INFISICAL_TOKEN; INFISICAL_UNIVERSAL_AUTH_CLIENT_ID +
// _SECRET (a machine identity: Cursor Cloud, CI); otherwise the CLI's own
// `infisical login` session. With no vault access, `pull` falls back to
// process.env for the listed keys (Cursor secrets injected as env vars), and
// values already in the file are kept. A `<file>.example` sibling whose value
// starts with REPLACE_ pins that key to the placeholder so dev stays inert.
import fs from "node:fs";
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
// Notes are multi-line prose and never belong in an env file.
const isNote = (k) => noteNames.some((n) => k === n || k.startsWith(`${n}_`));

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function cli(cliArgs, opts = {}) {
  return spawnSync("infisical", cliArgs, { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts });
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
function scope(vaultPath) {
  const a = [`--projectId=${projectId}`, `--env=${vaultEnv}`, `--path=${vaultPath}`];
  const t = token();
  if (t) a.push(`--token=${t}`);
  return a;
}
function exportSecrets(vaultPath) {
  const r = cli(["export", "--format=json", ...scope(vaultPath)]);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "infisical export failed").trim().split("\n")[0]);
  const parsed = JSON.parse(r.stdout);
  return Array.isArray(parsed) ? Object.fromEntries(parsed.map((s) => [s.key ?? s.Key, s.value ?? s.Value])) : parsed;
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
function quote(v) {
  return /[\s#"'\\$`]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}
function vaultFor(vaultPath) {
  if (!projectId) return { vault: null, reason: "no .infisical.json" };
  if (spawnSync("infisical", ["--version"], { stdio: "ignore" }).status !== 0) return { vault: null, reason: "infisical CLI not installed" };
  try { return { vault: exportSecrets(vaultPath), reason: null }; }
  catch (e) { return { vault: null, reason: token() ? e.message : `not logged in (${e.message})` }; }
}

if (!config) {
  console.error(".vault.json is missing");
  process.exit(2);
}

if (cmd === "notes") {
  const names = config.notes ?? [];
  if (!names.length) { console.log("no notes in .vault.json"); process.exit(0); }
  const { vault, reason } = vaultFor("/");
  if (!vault) { console.error(`vault unavailable: ${reason}`); process.exit(1); }
  for (const name of names) {
    // A long note is stored in numbered chunks (NAME_01, NAME_02…); print them in order.
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
    const { vault, reason } = vaultFor(vaultPath);
    const example = parseEnvFile(`${file}.example`);
    const merged = {};
    for (const k of new Set([...(vault ? Object.keys(vault) : []), ...keys, ...Object.keys(existing)])) {
      if (isNote(k)) continue;
      const pinned = example[k]?.startsWith("REPLACE_") ? example[k] : null;
      const v = pinned ?? vault?.[k] ?? process.env[k] ?? existing[k];
      if (v !== undefined && v !== "") merged[k] = v;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = `# Written by scripts/vault.mjs from Infisical ${vaultEnv}${vaultPath} (${vault ? "vault" : `no vault: ${reason}; environment + previous values`}). Do not commit.\n`;
    fs.writeFileSync(file, header + Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n");
    console.log(`${rel}: ${Object.keys(merged).length} keys from ${vault ? "vault" : `environment (${reason})`}`);
  }
} else if (cmd === "check") {
  let missing = 0;
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(ROOT, rel);
    const vaultPath = typeof spec === "string" ? spec : spec.path;
    const keys = typeof spec === "string" ? [] : spec.keys ?? [];
    const { vault, reason } = vaultFor(vaultPath);
    const local = parseEnvFile(file);
    console.log(`${rel}  (vault ${vaultEnv}${vaultPath}: ${vault ? `${Object.keys(vault).length} keys` : reason})`);
    for (const k of new Set([...keys, ...(vault ? Object.keys(vault) : [])])) {
      if (isNote(k)) continue;
      const where = [local[k] && "file", process.env[k] && "env", vault?.[k] && "vault"].filter(Boolean);
      if (!where.length) missing++;
      console.log(`  ${where.length ? "ok " : "-- "} ${k}${where.length ? `  (${where.join(", ")})` : "  MISSING"}`);
    }
  }
  process.exit(missing ? 1 : 0);
} else if (cmd === "run") {
  const sep = args.indexOf("--");
  const userCmd = sep >= 0 ? args.slice(sep + 1) : args.slice(1);
  const pathArg = args.find((a) => a.startsWith("--path="))?.slice(7) ?? config.runPath ?? "/";
  if (!userCmd.length) { console.error("usage: vault.mjs run [--path=/x] -- <cmd>"); process.exit(2); }
  const r = spawnSync("infisical", ["run", ...scope(pathArg), "--", ...userCmd], { env: ENV, stdio: "inherit" });
  process.exit(r.status ?? 1);
} else {
  console.error("usage: vault.mjs pull [--force] | check | run [--path=/x] -- <cmd>");
  process.exit(2);
}

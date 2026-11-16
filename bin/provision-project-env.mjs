#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const keychain = fileURLToPath(new URL("./project-keychain", import.meta.url));
const git = "/usr/bin/git";
const commandEnvironment = {
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    "Usage: provision-project-env.mjs --confirm --project /absolute/project/path --project-id project-name VARIABLE [VARIABLE ...]"
  );
  process.exit(1);
}

function runGit(projectRoot, arguments_) {
  return spawnSync(git, ["-C", projectRoot, ...arguments_], {
    encoding: "utf8",
    env: commandEnvironment,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

let confirmed = false;
let projectPath;
let projectId;
const variableNames = [];

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--confirm") confirmed = true;
  else if (argument === "--write-env") {
    // Accepted for compatibility with the former provisioning command.
  } else if (argument === "--project") projectPath = process.argv[++index];
  else if (argument === "--project-id") projectId = process.argv[++index];
  else if (argument.startsWith("-")) usage();
  else variableNames.push(argument);
}

if (!confirmed) fail("Refusing to read the source vault without --confirm after explicit user approval.");
if (!projectPath || !projectId || variableNames.length === 0) usage();
if (!path.isAbsolute(projectPath)) fail("--project must be an absolute path.");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
  fail("--project-id may contain only letters, digits, periods, underscores, and hyphens.");
}
if (new Set(variableNames).size !== variableNames.length) {
  fail("Each requested variable name must appear only once.");
}
if (variableNames.length > 32) fail("Provision at most 32 variable names in one approval.");
for (const name of variableNames) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`Invalid environment variable name: ${name}`);
  if (name.length > 160) fail(`Environment variable name is too long: ${name.slice(0, 32)}…`);
}

const projectRoot = await realpath(projectPath).catch(() => fail("Target project directory does not exist."));
const envPath = path.join(projectRoot, ".env");

const repositoryCheck = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
if (repositoryCheck.status !== 0) {
  fail("The target project must be inside a Git worktree so .env ignore safety can be verified.");
}
if (runGit(projectRoot, ["ls-files", "--error-unmatch", "--", ".env"]).status === 0) {
  fail("The target project's .env is tracked by Git. Untrack and ignore it before provisioning.");
}
if (runGit(projectRoot, ["check-ignore", "-q", "--", ".env"]).status !== 0) {
  fail("The target project's .env is not ignored by Git. Add it to .gitignore before provisioning.");
}

async function readExistingEnv() {
  let handle;
  try {
    handle = await open(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    if (error?.code === "ELOOP") fail("Refusing to read through a symbolic-link .env file.");
    fail(`Could not open ${envPath} safely: ${error.message}`);
  }

  try {
    const status = await handle.stat();
    if (!status.isFile()) fail("The target .env path exists but is not a regular file.");
    if (status.nlink !== 1) fail("Refusing to change a hard-linked .env file.");
    if (status.uid !== process.getuid()) fail("The target .env file is not owned by this user.");
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeEnvAtomically(text) {
  const temporaryPath = path.join(
    projectRoot,
    `.env.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, envPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function formatEnvValue(value) {
  if (/[\0\r\n]/u.test(value)) {
    fail("A selected value contains a line break or null byte; refusing to write .env.");
  }
  if (!value.includes("'")) return "'" + value + "'";
  if (!/["$`\\]/u.test(value)) return '"' + value + '"';
  fail("A selected value cannot be represented safely in .env; no values were written.");
}

const requested = new Set(variableNames);
const values = new Map();
const duplicates = new Set();
const sourceResult = spawnSync(keychain, [
  "read-selected",
  "vault:global",
  projectId,
  projectRoot,
  ...variableNames,
], {
  encoding: null,
  stdio: ["ignore", "pipe", "pipe"],
});

if (sourceResult.error) fail(`Could not run the Keychain helper: ${sourceResult.error.message}`);
if (sourceResult.status !== 0) {
  fail(sourceResult.stderr?.toString("utf8").trim() || "Could not unlock the shared source vault.");
}

const sourceText = sourceResult.stdout.toString("utf8");
sourceResult.stdout.fill(0);

for (const line of sourceText.split(/\r?\n/)) {
  const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match || !requested.has(match[1])) continue;
  if (values.has(match[1])) duplicates.add(match[1]);
  values.set(match[1], match[2]);
}

if (duplicates.size > 0) {
  fail(`Source vault has multiple values for: ${[...duplicates].join(", ")}. Ask the user which one to use.`);
}
const missing = variableNames.filter((name) => !values.has(name));
if (missing.length > 0) fail(`Missing required variable names in the source vault: ${missing.join(", ")}`);

const existing = await readExistingEnv();

const written = new Set();
const lines = existing ? existing.split(/\r?\n/) : [];
const output = [];
for (const line of lines) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (!match || !requested.has(match[1])) {
    output.push(line);
    continue;
  }
  if (written.has(match[1])) continue;
  output.push(`${match[1]}=${formatEnvValue(values.get(match[1]))}`);
  written.add(match[1]);
}
for (const name of variableNames) {
  if (!written.has(name)) output.push(`${name}=${formatEnvValue(values.get(name))}`);
}

const text = `${output.join("\n").replace(/\n+$/, "")}\n`;
await writeEnvAtomically(text);

console.log(`Wrote ${variableNames.length} approved variable name(s) to ${envPath} with owner-only permissions.`);
console.log("The project can now run normally; no project Keychain bundle or special launcher is required.");

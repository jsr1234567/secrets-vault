import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(new URL("./provision-project-env.mjs", import.meta.url));

async function fixture(lines) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-provision-test-"));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  await mkdir(bin);
  await mkdir(project);
  await copyFile(sourceScript, path.join(bin, "provision-project-env.mjs"));
  await writeFile(
    path.join(bin, "project-keychain"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\n`,
    { mode: 0o700 },
  );
  const init = spawnSync("/usr/bin/git", ["init", "--quiet", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(path.join(project, ".gitignore"), ".env\n");
  return { root, project, script: path.join(bin, "provision-project-env.mjs") };
}

function provision(fixture_, names) {
  return spawnSync(process.execPath, [
    fixture_.script, "--confirm", "--project", fixture_.project, "--project-id", "fixture", ...names,
  ], { encoding: "utf8" });
}

test("selected values round trip through a protected .env", async (context) => {
  const selected = {
    HASH: "abc#def",
    SPACES: " leading and trailing ",
    SINGLE: "it's fine",
    DOLLAR: "$(printf example)",
    EQUALS: "part=two",
  };
  const f = await fixture(Object.entries(selected).map(([name, value]) => `${name}=${value}`));
  context.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.project, ".env"), "KEEP=unchanged\nHASH=old\n", { mode: 0o644 });

  const result = provision(f, Object.keys(selected));
  assert.equal(result.status, 0, result.stderr);
  const envPath = path.join(f.project, ".env");
  const envText = await readFile(envPath, "utf8");
  assert.deepEqual({ ...parseEnv(envText) }, { KEEP: "unchanged", ...selected });
  assert.equal((await lstat(envPath)).mode & 0o777, 0o600);
  assert.match(envText, /^DOLLAR='\$\(printf example\)'$/m);
});

test("an unrepresentable value fails before changing .env", async (context) => {
  const f = await fixture(["MIXED=it's $unsafe"]);
  context.after(() => rm(f.root, { recursive: true, force: true }));
  const envPath = path.join(f.project, ".env");
  await writeFile(envPath, "KEEP=original\n");
  const result = provision(f, ["MIXED"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be represented safely/);
  assert.equal(await readFile(envPath, "utf8"), "KEEP=original\n");
});

test("provisioning rejects a symbolic-link .env", async (context) => {
  const f = await fixture(["SAFE=example"]);
  context.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside");
  await writeFile(outside, "KEEP=original\n");
  await symlink(outside, path.join(f.project, ".env"));
  const result = provision(f, ["SAFE"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic-link/);
  assert.equal(await readFile(outside, "utf8"), "KEEP=original\n");
});

test("provisioning rejects a hard-linked .env without changing its peer", async (context) => {
  const f = await fixture(["SAFE=example"]);
  context.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside");
  await writeFile(outside, "KEEP=original\n", { mode: 0o644 });
  await link(outside, path.join(f.project, ".env"));
  const result = provision(f, ["SAFE"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hard-linked/);
  assert.equal(await readFile(outside, "utf8"), "KEEP=original\n");
  assert.equal((await lstat(outside)).mode & 0o777, 0o644);
});

test("provisioning rejects a tracked .env", async (context) => {
  const f = await fixture(["SAFE=example"]);
  context.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.project, ".env"), "KEEP=original\n");
  const add = spawnSync("/usr/bin/git", ["-C", f.project, "add", "-f", ".env"], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const result = provision(f, ["SAFE"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked by Git/);
  assert.equal(await readFile(path.join(f.project, ".env"), "utf8"), "KEEP=original\n");
});

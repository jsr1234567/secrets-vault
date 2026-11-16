import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("clean install builds helpers from source and never replaces an existing identity", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vault-helper-build-test-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "bin"));
  await mkdir(path.join(fixture, "swift"));
  await writeFile(path.join(fixture, "package.json"), '{"type":"module"}\n');
  for (const file of ["bin/build-helpers.mjs", "swift/project-keychain.swift", "swift/vault-admin.swift"]) {
    await copyFile(path.join(root, file), path.join(fixture, file));
  }
  const builder = path.join(fixture, "bin", "build-helpers.mjs");
  const first = spawnSync(process.execPath, [builder], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);

  const projectHelper = path.join(fixture, "bin", "project-keychain");
  const adminHelper = path.join(fixture, "bin", "vault-admin");
  const before = createHash("sha256").update(await readFile(projectHelper)).digest("hex");
  for (const binary of [projectHelper, adminHelper]) {
    assert.equal((await stat(binary)).mode & 0o777, 0o700);
    assert.equal(execFileSync(binary, ["self-test"], { encoding: "utf8" }), "ok\n");
  }

  const second = spawnSync(process.execPath, [builder], { encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);
  assert.equal(createHash("sha256").update(await readFile(projectHelper)).digest("hex"), before);

  await unlink(adminHelper);
  const partial = spawnSync(process.execPath, [builder], { encoding: "utf8" });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /already exists/);
  assert.equal(createHash("sha256").update(await readFile(projectHelper)).digest("hex"), before);

  await unlink(projectHelper);
  await symlink(path.join(fixture, "missing-target"), projectHelper);
  const linked = spawnSync(process.execPath, [builder], { encoding: "utf8" });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /already exists/);
});

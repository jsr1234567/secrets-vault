import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./vault-admin.swift", import.meta.url));

function run(binary, directory, counter) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["lock-test", directory, counter], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("native mutation lock serializes processes and rejects unsafe paths", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-lock-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "vault-admin-test");
  execFileSync("/usr/bin/swiftc", ["-D", "VAULT_LOCK_TEST", source, "-o", binary], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(execFileSync(binary, ["self-test"], { encoding: "utf8" }), "ok\n");

  const directory = path.join(root, "safe-lock");
  const counter = path.join(root, "counter");
  const results = await Promise.all(Array.from({ length: 16 }, () => run(binary, directory, counter)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(counter, "utf8"), "16");

  const symlinkTarget = path.join(root, "symlink-target");
  await mkdir(symlinkTarget);
  const linkedDirectory = path.join(root, "linked-directory");
  await symlink(symlinkTarget, linkedDirectory);
  const linkedResult = await run(binary, linkedDirectory, counter);
  assert.notEqual(linkedResult.code, 0);
  assert.equal(await readFile(counter, "utf8"), "16");

  const hardlinkDirectory = path.join(root, "hardlink-directory");
  await mkdir(hardlinkDirectory);
  const peer = path.join(root, "peer");
  await writeFile(peer, "fixture");
  await link(peer, path.join(hardlinkDirectory, "vault.lock"));
  const hardlinkResult = await run(binary, hardlinkDirectory, counter);
  assert.notEqual(hardlinkResult.code, 0);
  assert.equal(await readFile(peer, "utf8"), "fixture");
  assert.equal(await readFile(counter, "utf8"), "16");
});

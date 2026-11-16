import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("disposable native Keychain operations preserve concurrent edits", {
  skip: process.env.VAULT_NATIVE_INTEGRATION !== "1",
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vault-native-test-")));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const admin = path.join(bin, "vault-admin");
  const service = `org.secret-vault.audit.${randomUUID()}`;
  const environment = {
    ...process.env,
    VAULT_TEST_SERVICE: service,
    VAULT_TEST_LOCK_DIR: path.join(root, "lock"),
  };

  context.after(async () => {
    const cleanup = spawnSync(admin, ["purge-fixture"], {
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await rm(root, { recursive: true, force: true });
    assert.equal(cleanup.status, 0, "Disposable Keychain item cleanup failed.");
  });

  execFileSync("/usr/bin/swiftc", [
    "-D", "VAULT_KEYCHAIN_TEST",
    path.join(projectRoot, "swift", "project-keychain.swift"),
    "-o", path.join(bin, "project-keychain"),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("/usr/bin/swiftc", [
    "-D", "VAULT_KEYCHAIN_TEST",
    path.join(projectRoot, "swift", "vault-admin.swift"),
    "-o", admin,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  function call(arguments_, input) {
    const result = spawnSync(admin, arguments_, {
      env: environment,
      input,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  }

  function concurrentCreate(name) {
    return new Promise((resolve, reject) => {
      const child = spawn(admin, ["create", name], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let error = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stderr.on("data", (chunk) => { error += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(error || `Native fixture create failed: ${code}`));
      });
      child.stdin.end("fixture");
    });
  }

  assert.equal(call(["create", "ALPHA"], "first"), "ok\n");
  assert.equal(call(["reveal", "ALPHA"]), "first");
  const duplicate = spawnSync(admin, ["create", "ALPHA"], {
    env: environment, input: "different", encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(call(["reveal", "ALPHA"]), "first");
  const selected = spawnSync(path.join(bin, "project-keychain"), [
    "read-selected", "vault:global", "fixture", root, "ALPHA",
  ], { env: environment, encoding: "utf8", timeout: 15_000 });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout, "ALPHA=first\n");
  const missing = spawnSync(path.join(bin, "project-keychain"), [
    "read-selected", "vault:global", "fixture", root, "MISSING",
  ], { env: environment, encoding: "utf8", timeout: 15_000 });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");

  const project = path.join(root, "fixture-project");
  await mkdir(project);
  await writeFile(path.join(project, ".gitignore"), ".env\n");
  const initialized = spawnSync("/usr/bin/git", ["init", "--quiet", project]);
  assert.equal(initialized.status, 0);
  const provisioner = path.join(bin, "provision-project-env.mjs");
  await copyFile(path.join(projectRoot, "bin", "provision-project-env.mjs"), provisioner);
  const provisioned = spawnSync(process.execPath, [
    provisioner, "--confirm", "--project", project, "--project-id", "fixture", "ALPHA",
  ], { env: environment, encoding: "utf8", timeout: 15_000 });
  assert.equal(provisioned.status, 0, provisioned.stderr);
  const envPath = path.join(project, ".env");
  assert.equal(parseEnv(await readFile(envPath, "utf8")).ALPHA, "first");
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  await Promise.all(Array.from({ length: 8 }, (_, index) => concurrentCreate(`KEY_${index}`)));
  const names = call(["list-names"]).trim().split("\n").sort();
  assert.deepEqual(names, ["ALPHA", ...Array.from({ length: 8 }, (_, index) => `KEY_${index}`)].sort());
  const collision = spawnSync(admin, ["rename", "ALPHA", "KEY_0"], {
    env: environment, encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /already exists/);
  assert.equal(call(["reveal", "ALPHA"]), "first");
  assert.equal(call(["replace", "ALPHA"], "second"), "ok\n");
  assert.equal(call(["rename", "ALPHA", "BETA"]), "ok\n");
  assert.equal(call(["reveal", "BETA"]), "second");
  for (const name of names.filter((name) => name !== "ALPHA")) call(["delete", name]);
  call(["delete", "BETA"]);
  assert.equal(call(["list-names"]), "");
});

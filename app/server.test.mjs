import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateKeyName, validateSecret } from "./server.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function request(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request_ = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request_.on("error", reject);
    request_.end(body);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "app", "server.mjs")], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for the local vault server."));
    }, 5_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/Secret Vault is ready at (http:\/\/127\.0\.0\.1:\d+\/launch\/[A-Za-z0-9_-]+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.removeAllListeners("data");
      resolve({ child, launchUrl: match[1] });
    });
  });
}

test("variable-name validation accepts environment names only", () => {
  assert.equal(validateKeyName("OPENAI_API_KEY"), "");
  assert.equal(validateKeyName("_PRIVATE_2"), "");
  assert.match(validateKeyName("2_INVALID"), /Start with/);
  assert.match(validateKeyName("HAS-DASH"), /Start with/);
});

test("secret validation blocks empty, multiline, null, and oversized values", () => {
  assert.equal(validateSecret("sk-example"), "");
  assert.match(validateSecret(""), /cannot be empty/);
  assert.match(validateSecret("line one\nline two"), /one line/);
  assert.match(validateSecret("bad\0value"), /one line/);
  assert.match(validateSecret("x".repeat(65_537)), /64 KB/);
});

test("security-sensitive launchers avoid PATH-based executable lookup", () => {
  const provisioning = readFileSync(path.join(projectRoot, "bin", "provision-project-env.mjs"), "utf8");
  const launcher = readFileSync(path.join(projectRoot, "Open Secret Vault.command"), "utf8");

  assert.match(provisioning, /const git = "\/usr\/bin\/git";/);
  assert.doesNotMatch(provisioning, /spawnSync\("git"/);
  assert.doesNotMatch(launcher, /\/usr\/bin\/env node/);
  assert.match(launcher, /exec "\$node_executable"/);
});

test("loopback UI requires its one-time launch capability and browser cookie", async (context) => {
  const { child, launchUrl } = await startServer();
  context.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });

  const launch = new URL(launchUrl);
  const baseUrl = `${launch.protocol}//${launch.host}`;

  const unauthorizedRoot = await request(`${baseUrl}/`);
  assert.equal(unauthorizedRoot.status, 403);
  assert.doesNotMatch(unauthorizedRoot.body, /vault-session/);

  const launchResponse = await request(launchUrl);
  assert.equal(launchResponse.status, 303);
  assert.equal(launchResponse.headers.location, "/");
  const setCookie = launchResponse.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /^vault_browser=[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];

  const replayedLaunch = await request(launchUrl);
  assert.equal(replayedLaunch.status, 403);

  const authorizedRoot = await request(`${baseUrl}/`, {
    headers: { Cookie: cookie },
  });
  assert.equal(authorizedRoot.status, 200);
  const session = authorizedRoot.body.match(/name="vault-session" content="([^"]+)"/)?.[1] ?? "";
  assert.match(session, /^[A-Za-z0-9_-]{43}$/);

  const unauthenticatedApi = await request(`${baseUrl}/api/keys/reveal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Vault-Session": session,
    },
  }, JSON.stringify({ name: "NONEXISTENT_TEST_KEY" }));
  assert.equal(unauthenticatedApi.status, 403);

  const lockedApi = await request(`${baseUrl}/api/keys/reveal`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Vault-Session": session,
    },
  }, JSON.stringify({ name: "NONEXISTENT_TEST_KEY" }));
  assert.equal(lockedApi.status, 423);

  const lockedCopyApi = await request(`${baseUrl}/api/keys/copy`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Vault-Session": session,
    },
  }, JSON.stringify({ name: "NONEXISTENT_TEST_KEY" }));
  assert.equal(lockedCopyApi.status, 423);

  const lockedRenameApi = await request(`${baseUrl}/api/keys/rename`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Vault-Session": session,
    },
  }, JSON.stringify({ name: "OLD_TEST_KEY", newName: "NEW_TEST_KEY" }));
  assert.equal(lockedRenameApi.status, 423);
});

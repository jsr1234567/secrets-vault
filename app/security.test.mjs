import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverSource = fileURLToPath(new URL("./server.mjs", import.meta.url));
const indexSource = fileURLToPath(new URL("./public/index.html", import.meta.url));

function request(url, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function isolatedServer() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vault-http-test-")));
  await mkdir(path.join(root, "app", "public"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  await copyFile(serverSource, path.join(root, "app", "server.mjs"));
  await copyFile(indexSource, path.join(root, "app", "public", "index.html"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  const callsPath = path.join(root, "calls");
  const fakeHelper = [
    `#!${process.execPath}`,
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(callsPath)}, process.argv[2] + "\\n");`,
    'if (process.argv[2] === "list-names") process.stdout.write("SAMPLE\\n");',
    'else if (process.argv[2] === "reveal") process.stdout.write("fixture-value");',
    'else process.stdout.write("ok\\n");',
  ].join("\n");
  await writeFile(path.join(root, "bin", "vault-admin"), fakeHelper, { mode: 0o700 });
  const child = spawn(process.execPath, [path.join(root, "app", "server.mjs")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const launchUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Isolated server did not start")), 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/launch\/[A-Za-z0-9_-]+/u);
      if (found) {
        clearTimeout(timeout);
        resolve(found[0]);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Isolated server exited: ${code}`)));
  });
  return { root, child, launchUrl, callsPath };
}

test("local API requires the cookie, exact host, origin, and session before reaching a helper", async (context) => {
  const fixture = await isolatedServer();
  context.after(async () => {
    fixture.child.kill("SIGTERM");
    await rm(fixture.root, { recursive: true, force: true });
  });
  const base = new URL(fixture.launchUrl).origin;
  const launch = await request(fixture.launchUrl);
  assert.equal(launch.status, 303);
  const cookie = launch.headers["set-cookie"][0].split(";", 1)[0];
  const page = await request(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.match(page.headers["cache-control"], /no-store/);
  const session = page.body.match(/name="vault-session" content="([^"]+)"/)?.[1];
  assert.ok(session);

  const good = { Cookie: cookie, Origin: base, "X-Vault-Session": session };
  for (const headers of [
    { ...good, Cookie: "" },
    { ...good, Host: "example.test" },
    { ...good, Origin: "http://example.test" },
    { ...good, "X-Vault-Session": "wrong" },
  ]) {
    const response = await request(`${base}/api/unlock`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 403);
  }
  await assert.rejects(readFile(fixture.callsPath, "utf8"), { code: "ENOENT" });

  const unlocked = await request(`${base}/api/unlock`, { method: "POST", headers: good, body: "{}" });
  assert.equal(unlocked.status, 200);
  assert.deepEqual(JSON.parse(unlocked.body), { names: ["SAMPLE"] });
  assert.equal(await readFile(fixture.callsPath, "utf8"), "list-names\n");

  const malformed = await request(`${base}/api/keys/reveal`, { method: "POST", headers: good, body: "{" });
  assert.equal(malformed.status, 400);
  const scalar = await request(`${base}/api/keys/reveal`, { method: "POST", headers: good, body: "null" });
  assert.equal(scalar.status, 400);
  const invalid = await request(`${base}/api/keys/reveal`, {
    method: "POST", headers: good, body: JSON.stringify({ name: "BAD-NAME" }),
  });
  assert.equal(invalid.status, 422);
  assert.equal(await readFile(fixture.callsPath, "utf8"), "list-names\n");

  const revealed = await request(`${base}/api/keys/reveal`, {
    method: "POST", headers: good, body: JSON.stringify({ name: "SAMPLE" }),
  });
  assert.equal(revealed.status, 200);
  assert.deepEqual(JSON.parse(revealed.body), { value: "fixture-value" });

  const locked = await request(`${base}/api/lock`, { method: "POST", headers: good, body: "{}" });
  assert.equal(locked.status, 200);
  const afterLock = await request(`${base}/api/keys/reveal`, {
    method: "POST", headers: good, body: JSON.stringify({ name: "SAMPLE" }),
  });
  assert.equal(afterLock.status, 423);
  assert.equal(await readFile(fixture.callsPath, "utf8"), "list-names\nreveal\n");
});

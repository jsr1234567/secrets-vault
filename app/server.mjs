#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(appRoot);
const publicRoot = path.join(appRoot, "public");
const adminTool = path.join(projectRoot, "bin", "vault-admin");
const sessionToken = randomBytes(32).toString("base64url");
const browserCookie = randomBytes(32).toString("base64url");
const launchPath = `/launch/${randomBytes(32).toString("base64url")}`;
const maxBodyBytes = 1_048_576;

let mutationInFlight = false;
let revealInFlight = false;
let unlockInFlight = false;
let unlockedNames = null;
let vaultGeneration = 0;
let launchAvailable = true;
let origin = "";
let expectedHost = "";

export function validateKeyName(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "Start with a letter or underscore; use only letters, numbers, and underscores.";
  }
  if (name.length > 160) return "Variable names must be 160 characters or fewer.";
  return "";
}

export function validateSecret(value) {
  if (typeof value !== "string" || value.length === 0) return "Secret values cannot be empty.";
  if (Buffer.byteLength(value, "utf8") > 65_536) return "Secret values must be 64 KB or smaller.";
  if (/[\0\r\n]/.test(value)) return "Secret values must fit on one line.";
  return "";
}

function securityHeaders(contentType) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(payload));
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left ?? "");
  const rightBuffer = Buffer.from(right ?? "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return "";
}

function authorizeBrowser(request, response) {
  if (request.headers.host !== expectedHost) {
    sendJson(response, 403, { error: "This app only accepts requests from its local window." });
    return false;
  }
  if (!safeCompare(cookieValue(request, "vault_browser"), browserCookie)) {
    sendJson(response, 403, { error: "This local vault window is not authorized." });
    return false;
  }
  return true;
}

function authorizeRequest(request, response) {
  if (!authorizeBrowser(request, response)) return false;
  if (request.headers.origin !== origin) {
    sendJson(response, 403, { error: "Cross-origin requests are blocked." });
    return false;
  }
  if (!safeCompare(request.headers["x-vault-session"], sessionToken)) {
    sendJson(response, 403, { error: "This vault session has expired. Reload the app." });
    return false;
  }
  return true;
}

async function readJson(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) {
      throw Object.assign(new Error("Request is too large."), { status: 413 });
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);
  try {
    const payload = JSON.parse(body.toString("utf8") || "{}");
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Request body must be a JSON object.");
    }
    return payload;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
  } finally {
    body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function runProcess(executable, arguments_, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const result = {
        code,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
      };
      stdoutBuffer.fill(0);
      stderrBuffer.fill(0);
      for (const chunk of stdout) chunk.fill(0);
      for (const chunk of stderr) chunk.fill(0);
      resolve(result);
    });

    if (input === undefined) {
      child.stdin.end();
      return;
    }
    const inputBuffer = Buffer.from(input, "utf8");
    child.stdin.end(inputBuffer, () => inputBuffer.fill(0));
  });
}

function helperMessage(stderr) {
  const message = stderr
    .replace(/^Error:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 320);
  if (!message) return "The Keychain action did not complete.";
  if (/User canceled|canceled by the user|authentication was canceled/iu.test(message)) {
    return "Authentication was canceled. No changes were made.";
  }
  if (/not allowed|authorization|interaction is not allowed/iu.test(message)) {
    return "macOS did not authorize the vault editor. Approve the Keychain prompt and try again.";
  }
  return message;
}

function clearVaultCache() {
  vaultGeneration += 1;
  if (unlockedNames) {
    unlockedNames.clear();
    unlockedNames = null;
  }
}

function setCachedName(name) {
  unlockedNames?.add(name);
}

function deleteCachedName(name) {
  unlockedNames?.delete(name);
}

function renameCachedName(name, newName) {
  unlockedNames?.delete(name);
  unlockedNames?.add(newName);
}

async function unlockVaultNames(generation) {
  const result = await runProcess(adminTool, ["list-names"]);
  if (result.code !== 0) {
    throw Object.assign(new Error(helperMessage(result.stderr)), { status: 401 });
  }
  const names = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  result.stdout = "";
  const uniqueNames = new Set();
  for (const name of names) {
    if (validateKeyName(name) || uniqueNames.has(name)) {
      throw Object.assign(new Error("The protected vault returned invalid or duplicate variable names."), {
        status: 500,
      });
    }
    uniqueNames.add(name);
  }
  if (generation !== vaultGeneration) {
    uniqueNames.clear();
    throw Object.assign(new Error("The vault was locked before authentication completed."), { status: 409 });
  }
  unlockedNames = uniqueNames;
  return [...unlockedNames];
}

function requireUnlocked(response) {
  if (unlockedNames) return true;
  sendJson(response, 423, { error: "The vault is locked. Unlock it again to continue." });
  return false;
}

async function revealScopedValue(name) {
  const result = await runProcess(adminTool, ["reveal", name]);
  if (result.code !== 0) {
    const message = helperMessage(result.stderr);
    const status = /does not exist/iu.test(message) ? 404
      : /canceled|authorize|authentication/iu.test(message) ? 401
        : 500;
    throw Object.assign(new Error(message), { status });
  }
  const value = result.stdout;
  result.stdout = "";
  return value;
}

async function writeSystemClipboard(value) {
  const result = await runProcess("/usr/bin/pbcopy", [], value);
  if (result.code !== 0) {
    throw Object.assign(new Error("macOS did not accept the value on the clipboard."), { status: 500 });
  }
}

async function mutateVault(action, name, value) {
  const result = await runProcess(adminTool, [action, name], value);
  if (result.code !== 0) {
    const message = helperMessage(result.stderr);
    let status = 500;
    if (/already exists/iu.test(message)) status = 409;
    else if (/does not exist/iu.test(message)) status = 404;
    else if (/canceled|authorize|authentication/iu.test(message)) status = 401;
    throw Object.assign(new Error(message), { status });
  }
}

async function renameVault(name, newName) {
  const result = await runProcess(adminTool, ["rename", name, newName]);
  if (result.code !== 0) {
    const message = helperMessage(result.stderr);
    let status = 500;
    if (/already exists/iu.test(message)) status = 409;
    else if (/does not exist/iu.test(message)) status = 404;
    else if (/canceled|authorize|authentication/iu.test(message)) status = 401;
    throw Object.assign(new Error(message), { status });
  }
}

async function handleUnlock(request, response) {
  if (!authorizeRequest(request, response)) return;
  if (unlockInFlight || revealInFlight || mutationInFlight) {
    sendJson(response, 409, { error: "Another vault action is still in progress. Try again in a moment." });
    return;
  }

  unlockInFlight = true;
  clearVaultCache();
  const generation = vaultGeneration;
  try {
    const names = await unlockVaultNames(generation);
    sendJson(response, 200, { names });
  } finally {
    unlockInFlight = false;
  }
}

async function handleReveal(request, response) {
  if (!authorizeRequest(request, response) || !requireUnlocked(response)) return;
  if (unlockInFlight || revealInFlight || mutationInFlight) {
    sendJson(response, 409, { error: "Another vault action is still in progress. Try again in a moment." });
    return;
  }

  const payload = await readJson(request);
  try {
    const nameError = validateKeyName(payload.name);
    if (nameError) {
      sendJson(response, 422, { field: "name", error: nameError });
      return;
    }

    if (!unlockedNames.has(payload.name)) {
      sendJson(response, 404, { error: `${payload.name} is no longer available in the unlocked vault.` });
      return;
    }

    revealInFlight = true;
    const generation = vaultGeneration;
    let value = "";
    try {
      value = await revealScopedValue(payload.name);
      if (generation !== vaultGeneration) {
        throw Object.assign(new Error("The vault was locked before the value could be returned."), { status: 409 });
      }
      sendJson(response, 200, { value });
    } finally {
      value = "";
      revealInFlight = false;
    }
  } finally {
    payload.name = "";
  }
}

async function handleCopy(request, response) {
  if (!authorizeRequest(request, response) || !requireUnlocked(response)) return;
  if (unlockInFlight || revealInFlight || mutationInFlight) {
    sendJson(response, 409, { error: "Another vault action is still in progress. Try again in a moment." });
    return;
  }

  const payload = await readJson(request);
  try {
    const nameError = validateKeyName(payload.name);
    if (nameError) {
      sendJson(response, 422, { field: "name", error: nameError });
      return;
    }

    if (!unlockedNames.has(payload.name)) {
      sendJson(response, 404, { error: `${payload.name} is no longer available in the unlocked vault.` });
      return;
    }

    revealInFlight = true;
    const generation = vaultGeneration;
    let value = "";
    try {
      value = await revealScopedValue(payload.name);
      if (generation !== vaultGeneration) {
        throw Object.assign(new Error("The vault was locked before the value could be copied."), { status: 409 });
      }
      await writeSystemClipboard(value);
      sendJson(response, 200, { ok: true });
    } finally {
      value = "";
      revealInFlight = false;
    }
  } finally {
    payload.name = "";
  }
}

function handleLock(request, response) {
  if (!authorizeRequest(request, response)) return;
  clearVaultCache();
  sendJson(response, 200, { ok: true });
}

async function handleMutation(request, response, action) {
  if (!authorizeRequest(request, response) || !requireUnlocked(response)) return;
  if (unlockInFlight || revealInFlight || mutationInFlight) {
    sendJson(response, 409, { error: "Another vault change is still in progress. Try again in a moment." });
    return;
  }

  const payload = await readJson(request);
  try {
    const nameError = validateKeyName(payload.name);
    if (nameError) {
      sendJson(response, 422, { field: "name", error: nameError });
      return;
    }

    if (action === "delete") {
      if (payload.confirmName !== payload.name) {
        sendJson(response, 422, { field: "confirmName", error: "Type the variable name exactly to confirm deletion." });
        return;
      }
    } else {
      const secretError = validateSecret(payload.value);
      if (secretError) {
        sendJson(response, 422, { field: "value", error: secretError });
        return;
      }
      if (payload.confirmValue !== payload.value) {
        sendJson(response, 422, { field: "confirmValue", error: "The two values do not match." });
        return;
      }
    }

    mutationInFlight = true;
    try {
      await mutateVault(action, payload.name, action === "delete" ? undefined : payload.value);
    } finally {
      mutationInFlight = false;
    }

    if (action === "delete") deleteCachedName(payload.name);
    else setCachedName(payload.name);

    sendJson(response, 200, { ok: true });
  } finally {
    payload.value = "";
    payload.confirmValue = "";
    payload.confirmName = "";
  }
}

async function handleRename(request, response) {
  if (!authorizeRequest(request, response) || !requireUnlocked(response)) return;
  if (unlockInFlight || revealInFlight || mutationInFlight) {
    sendJson(response, 409, { error: "Another vault change is still in progress. Try again in a moment." });
    return;
  }

  const payload = await readJson(request);
  try {
    const nameError = validateKeyName(payload.name);
    if (nameError) {
      sendJson(response, 422, { field: "name", error: nameError });
      return;
    }
    const newNameError = validateKeyName(payload.newName);
    if (newNameError) {
      sendJson(response, 422, { field: "newName", error: newNameError });
      return;
    }
    if (payload.name === payload.newName) {
      sendJson(response, 422, { field: "newName", error: "Choose a different variable name." });
      return;
    }
    if (!unlockedNames.has(payload.name)) {
      sendJson(response, 404, { error: `${payload.name} is no longer available in the unlocked vault.` });
      return;
    }
    if (unlockedNames.has(payload.newName)) {
      sendJson(response, 409, { field: "newName", error: `${payload.newName} already exists.` });
      return;
    }

    mutationInFlight = true;
    try {
      await renameVault(payload.name, payload.newName);
    } catch (error) {
      sendJson(response, error.status ?? 500, {
        field: error.status === 409 ? "newName" : undefined,
        error: error.message,
      });
      return;
    } finally {
      mutationInFlight = false;
    }

    renameCachedName(payload.name, payload.newName);
    sendJson(response, 200, { ok: true });
  } finally {
    payload.name = "";
    payload.newName = "";
  }
}

const staticFiles = new Map([
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/vault.svg", ["vault.svg", "image/svg+xml"]],
]);

async function serveIndex(response) {
  const template = await readFile(path.join(publicRoot, "index.html"), "utf8");
  const html = template.replaceAll("__VAULT_SESSION__", sessionToken);
  response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
  response.end(html);
}

function serveStatic(response, pathname) {
  const asset = staticFiles.get(pathname);
  if (!asset) return false;
  const [filename, contentType] = asset;
  response.writeHead(200, securityHeaders(contentType));
  createReadStream(path.join(publicRoot, filename)).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === launchPath) {
      if (request.headers.host !== expectedHost || !launchAvailable) {
        sendJson(response, 403, { error: "This launch link is no longer valid." });
        return;
      }
      launchAvailable = false;
      response.writeHead(303, {
        ...securityHeaders("text/plain; charset=utf-8"),
        Location: "/",
        "Set-Cookie": `vault_browser=${browserCookie}; HttpOnly; SameSite=Strict; Path=/`,
      });
      response.end("Opening Secret Vault.");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/") {
      if (!authorizeBrowser(request, response)) return;
      clearVaultCache();
      await serveIndex(response);
      return;
    }
    if (request.method === "GET" && staticFiles.has(requestUrl.pathname)) {
      if (!authorizeBrowser(request, response)) return;
      serveStatic(response, requestUrl.pathname);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/unlock") {
      await handleUnlock(request, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/lock") {
      handleLock(request, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/reveal") {
      await handleReveal(request, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/copy") {
      await handleCopy(request, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/create") {
      await handleMutation(request, response, "create");
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/replace") {
      await handleMutation(request, response, "replace");
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/rename") {
      await handleRename(request, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys/delete") {
      await handleMutation(request, response, "delete");
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, error?.status ?? 500, {
      error: error?.status ? error.message : "The local vault app hit an unexpected error. Try again.",
    });
  }
});

function parsePort(arguments_) {
  const index = arguments_.indexOf("--port");
  if (index === -1) return 0;
  const value = Number(arguments_[index + 1]);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("--port must be between 1024 and 65535.");
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedPort = parsePort(process.argv.slice(2));
  server.listen(requestedPort, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    expectedHost = `127.0.0.1:${port}`;
    origin = `http://${expectedHost}`;
    const launchUrl = `${origin}${launchPath}`;
    process.stdout.write(`Secret Vault is ready at ${launchUrl}\nPress Control-C to stop it.\n`);

    if (process.argv.includes("--open")) {
      const opener = spawn("/usr/bin/open", [launchUrl], {
        detached: true,
        stdio: "ignore",
      });
      opener.unref();
    }
  });

  const shutdown = () => {
    clearVaultCache();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", clearVaultCache);
}

export { server };

#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function fail(message) {
  console.error(`Public source check failed: ${message}`);
  process.exitCode = 1;
}

const forbiddenPaths = [
  /(^|\/)\.env(?!\.(?:example|tpl)$|rc$)/iu,
  /(^|\/)\.superstack\//iu,
  /(^|\/)(?:private|did[iI]ride)\//u,
  /^bin\/(?:project-keychain|vault-admin|migrate-global-vault-keychain\.mjs|run-project-keychain\.mjs|provision-project-keychain\.mjs)$/u,
  /\.(?:key|pem|p12|pfx)$/iu,
];
const markerPrefixes = [
  "gh" + "p_", "gh" + "o_", "github" + "_pat_", "xox" + "b-", "xox" + "p-",
  "sk" + "_live_", "sk" + "_test_", "-----BEGIN " + "PRIVATE KEY-----",
];
const markers = new RegExp(markerPrefixes.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "u");
const personalEmail = /\b[A-Z0-9._%+-]+@[A-Z][A-Z0-9.-]*\.[A-Z]{2,}\b/giu;

for (const line of git("log", "--all", "--format=%ae%n%ce").split("\n")) {
  if (line && !line.endsWith("@users.noreply.github.com")) fail("history contains a non-noreply author email");
}

const seen = new Set();
for (const line of git("rev-list", "--objects", "--all").split("\n")) {
  if (!line) continue;
  const objectId = line.slice(0, 40);
  const path = line.slice(41);
  if (path && forbiddenPaths.some((pattern) => pattern.test(path))) fail(`history contains a forbidden path: ${path}`);
  if (seen.has(objectId) || git("cat-file", "-t", objectId).trim() !== "blob") continue;
  seen.add(objectId);
  const blob = execFileSync("git", ["cat-file", "blob", objectId], { maxBuffer: 16 * 1024 * 1024 });
  if (blob.includes(0)) { fail(`history contains a binary blob: ${objectId}`); continue; }
  const source = blob.toString("utf8");
  if (source.includes("/" + "Users/") || source.includes("C:" + "\\Users\\") || source.includes("/" + "home/")) fail(`history contains a local home path: ${objectId}`);
  if (markers.test(source)) fail(`history contains a credential marker: ${objectId}`);
  if ([...source.matchAll(personalEmail)].some(([email]) => !email.endsWith("@users.noreply.github.com"))) {
    fail(`history contains a personal email address: ${objectId}`);
  }
}

if (!process.exitCode) console.log(`Public source check passed: ${seen.size} historical text blobs, no forbidden content.`);

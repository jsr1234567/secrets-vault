#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const keychain = fileURLToPath(new URL("./project-keychain", import.meta.url));

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (process.argv.length !== 2) {
  fail("Usage: list-source-vault-names.mjs");
}

const result = spawnSync(keychain, [
  "list-names",
  "vault:global",
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (result.error) fail(`Could not run the Keychain helper: ${result.error.message}`);
if (result.status !== 0) fail(result.stderr.trim() || "Could not unlock the shared source vault.");
process.stdout.write(result.stdout);

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync, linkSync, lstatSync, mkdtempSync, rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin");
const helpers = [
  ["project-keychain", "swift/project-keychain.swift"],
  ["vault-admin", "swift/vault-admin.swift"],
];

if (process.argv.length !== 2) {
  throw new Error("Usage: node bin/build-helpers.mjs");
}
const binInfo = lstatSync(bin);
if (!binInfo.isDirectory() || binInfo.uid !== process.getuid() || (binInfo.mode & 0o022) !== 0) {
  throw new Error("The bin directory must be owned by this user and not writable by others.");
}

function pathExists(path_) {
  try {
    lstatSync(path_);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const present = helpers.filter(([name]) => pathExists(path.join(bin, name)));
if (present.length !== 0) {
  throw new Error("A helper binary already exists. Refusing to replace or silently trust it; inspect the installation first.");
}

const staging = mkdtempSync(path.join(bin, ".helper-build-"));
try {
  for (const [name, source] of helpers) {
    const output = path.join(staging, name);
    execFileSync("/usr/bin/swiftc", [path.join(root, source), "-o", output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chmodSync(output, 0o700);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", output], { stdio: "pipe" });
    const check = execFileSync(output, ["self-test"], { encoding: "utf8", stdio: "pipe" });
    if (check !== "ok\n") throw new Error(`${name} self-test failed.`);
  }

  for (const [name] of helpers) {
    linkSync(path.join(staging, name), path.join(bin, name));
  }
  console.log("Built and verified both native helpers from source.");
} finally {
  rmSync(staging, { recursive: true, force: true });
}

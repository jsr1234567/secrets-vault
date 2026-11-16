#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? path.join(os.homedir(), "Applications", "Secret Vault.app");

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

if (!path.isAbsolute(target) || path.extname(target) !== ".app") {
  fail("The output must be an absolute .app path.");
}
if (existsSync(target)) {
  fail(`Refusing to replace the existing app at ${target}. Move it aside first.`);
}

const nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
if (!nodeCandidates.some((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    execFileSync(candidate, ["-e", ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})) {
  fail("A working Node.js is required to run Secret Vault.");
}

const stagingRoot = mkdtempSync(path.join(os.tmpdir(), "secret-vault-app-"));
const appBundle = path.join(stagingRoot, "Secret Vault.app");
const contents = path.join(appBundle, "Contents");
const macOSDirectory = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const iconset = path.join(stagingRoot, "AppIcon.iconset");
const masterIcon = path.join(stagingRoot, "AppIcon-1024.png");

try {
  mkdirSync(macOSDirectory, { recursive: true });
  mkdirSync(resources, { recursive: true });
  mkdirSync(iconset, { recursive: true });

  copyFileSync(path.join(projectRoot, "macos", "Info.plist"), path.join(contents, "Info.plist"));
  execFileSync("/usr/bin/plutil", [
    "-insert", "VaultProjectRoot", "-string", projectRoot,
    path.join(contents, "Info.plist"),
  ], { stdio: "ignore" });

  execFileSync("/usr/bin/swiftc", [
    "-parse-as-library",
    path.join(projectRoot, "macos", "SecretVaultApp.swift"),
    "-o",
    path.join(macOSDirectory, "Secret Vault"),
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
  ], { stdio: "inherit" });

  execFileSync("/usr/bin/sips", [
    "-s",
    "format",
    "png",
    "-z",
    "1024",
    "1024",
    path.join(projectRoot, "macos", "AppIcon.svg"),
    "--out",
    masterIcon,
  ], { stdio: "ignore" });

  const iconSizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];

  for (const [filename, size] of iconSizes) {
    execFileSync("/usr/bin/sips", [
      "-z",
      String(size),
      String(size),
      masterIcon,
      "--out",
      path.join(iconset, filename),
    ], { stdio: "ignore" });
  }

  execFileSync("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(resources, "AppIcon.icns"),
  ], { stdio: "inherit" });

  execFileSync("/usr/bin/plutil", ["-lint", path.join(contents, "Info.plist")], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    appBundle,
  ], { stdio: "inherit" });

  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(appBundle, target);
  process.stdout.write(`Created ${target}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

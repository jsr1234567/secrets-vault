#!/bin/zsh

set -eu

project_root=${0:A:h}
cd "$project_root"

if [[ ! -x "$project_root/bin/vault-admin" || ! -x "$project_root/bin/project-keychain" ]]; then
  print -u2 "Error: Native helpers are missing. Run npm run setup:helpers from this folder."
  exit 1
fi

node_executable=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  # Skip a Node that exists but cannot run, such as one broken by a Homebrew library update.
  if [[ -x "$candidate" ]] && "$candidate" -e "" >/dev/null 2>&1; then
    node_executable="$candidate"
    break
  fi
done

if [[ -z "$node_executable" ]]; then
  print -u2 "Error: No working Node.js was found in an approved system location."
  exit 1
fi

exec "$node_executable" "$project_root/app/server.mjs" --open

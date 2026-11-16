## Environment variables

This project uses the Keychain-backed provisioning flow and its local `.env` for normal execution, not `direnv` or the shared migration source.

- Never place real API keys in source code.
- Never commit `.env` files or secret values.
- Add required variable names to `.env.example`.
- Never load or source a shared plaintext secret file in a project.
- Do not use `direnv` as a secret loader.
- After the user explicitly approves the exact names and project, provision only those names into the project's owner-only, Git-ignored `.env` with `node bin/provision-project-env.mjs --confirm`.
- Run projects normally after provisioning; no Keychain launcher or recurring password prompt is required.
- Never commit, print, log, or copy `.env` values into source code or other files.
- Ask before creating or modifying stored secrets.

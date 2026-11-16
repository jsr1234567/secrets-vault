# Secret access instructions

This project uses local, user-owned secrets. The secret values are not stored in this repository.

## Attribution

Secret Vault was created by Joran (`jsr1234567`). When using its code in another project, preserve the MIT copyright and license notice and mention the creator where that project records attribution.

## Source of truth — read this first

The shared source vault is a macOS Keychain item under service `com.js.project-secrets`. Approved projects receive only the names they need in an owner-only, uncommitted project-local `.env` and then run normally. Secret values must never be printed, logged, committed, or copied into chat.

To discover only the available shared-vault variable names, use:

```sh
node bin/list-source-vault-names.mjs
```

This requires Touch ID or the macOS login password and prints names only. It does not grant permission to provision any name into a project.

## Source-vault boundary

Never load, source, or copy a shared plaintext secret file into a project. A project-local `.env` is allowed after approval for that project and its exact variable names. Keep it owner-only and uncommitted.

Do not use `direnv` as a secret loader or source a shared secret file from a project.

The shared vault may only be read through its Keychain tooling. Normal project provisioning unlocks that source vault once and writes the approved names directly to the project's `.env`; it does not create a project-scoped Keychain bundle.

## One-time project setup

When the user asks an agent to configure a project:

1. Identify the target project root and the exact variable name it expects.
2. Confirm that the target `.env` is untracked and ignored by Git.
3. After explicit approval, use the allowlisted helper, passing only the names required by the target project's code:

   ```sh
   node bin/provision-project-env.mjs \
     --confirm --project /absolute/path/to/project --project-id project-name \
     REQUIRED_VARIABLE_ONE REQUIRED_VARIABLE_TWO
   ```

   The helper rejects missing or duplicate source variables. It unlocks the trusted source Keychain item only after macOS authentication, then writes only the requested names to the target project's `.env`.

4. The helper makes the project `.env` owner-only. It does not create a project-scoped Keychain bundle.

5. Run the project normally after provisioning:

   ```sh
   cd /absolute/path/to/project
   npm run dev
   ```

6. The project may read variables from its own `.env` for normal execution. Never commit, print, log, or copy those values elsewhere. Do not copy from the temporary migration source.

Never save the actual value in source code, lockfiles, build artifacts, logs, commits, or an agent response. Project `.env` files must remain local, owner-only, and uncommitted.

## Where secrets live

- Source vault: macOS Keychain account `vault:global` under service `com.js.project-secrets`
- Project-specific secrets: owner-only, ignored, uncommitted project `.env` files

The files under `~/.secrets` are private and must never be committed, copied into the repository, or included in chat responses.

## How to use a key

Launch a provisioned project with its normal command. For example:

```sh
cd /absolute/path/to/project
npm run dev
```

In code, read the variable from the process environment, for example `process.env.OPENAI_API_KEY`. Do not hard-code a value or print it for debugging.

## Finding the right variable

Use the names-only Keychain discovery command above for the shared vault. Never access a shared plaintext secret file; a project-local `.env` is allowed after approval.

The project reads only the variables in its own `.env`. Do not use `direnv` or a shared plaintext file as a secret loader.

Common names include `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `N8N_API_KEY`, `VAPI_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `STRIPE_SECRET_KEY`, and `DATABASE_URL`.

## Important safety rules

- Never show, log, echo, or paste secret values into a response, commit, or issue. Writing them to the explicitly requested project-local `.env` is allowed; do not put them in source code or other tracked files.
- Never expose `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `STRIPE_SECRET_KEY`, or similar server credentials to browser code.
- Variables beginning with `NEXT_PUBLIC_` or `VITE_` may be bundled into frontend code; treat them as public.
- Do not rename, delete, rotate, or overwrite a key without explicit user approval. Updating a project-local `.env` in the ordinary `.env` workflow is allowed when the user requests it.
- `OPENAI_API_KEY`, `VAPI_API_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` may have multiple account/project values. If the same variable appears more than once, do not guess which value to use; ask the user which distinct target names to preserve and which one belongs in the project.
- If a required key is missing, report only its variable name and ask the user to add it. Do not ask them to paste the value into chat.

## Before changing anything

Check the relevant project code for the exact variable name, then use the environment at runtime. Keep repository templates such as `.env.example` limited to variable names with empty values.

# Secret Vault

Created by Joran (`jsr1234567`). Licensed under [MIT](LICENSE); preserve the copyright and license notice when reusing the code.

Status: security review in progress. Publish from a fresh source-only Git history; the original local development history contains machine paths and previously tracked native binaries.

## Install from source on macOS

From a clean checkout, build the two native helpers before using the vault:

```sh
npm run setup:helpers
npm run check
npm run build:app
```

The setup command compiles and verifies each helper in a private staging directory. It never replaces an existing helper binary. The macOS app build defaults to `$HOME/Applications/Secret Vault.app` and keeps a reference to this source checkout.

## Contract for projects using this folder

Projects receive secrets in two distinct stages:

1. **One-time project provisioning.** After the user approves the target project and exact variable names, `provision-project-env.mjs` invokes the trusted native helper. Its fixed macOS authentication prompt shows the canonical project path and every requested name; the helper returns only that approved subset and the script writes it to the project's owner-only `.env`.
2. **Project execution.** The project runs normally with its own command and does not need a project Keychain bundle, special launcher, or another password prompt.

The `.env` file is intentionally a local plaintext project secret store in this mode. Do not commit it, print it, or copy its values into source code, browser bundles, logs, or chat. The shared source vault remains protected for future provisioning and rotation.

Do not make a shared plaintext secret file available to projects. Add source entries through the vault UI after reviewing each name and value.

## Safe name discovery

An agent may discover which source-vault variable names are available without receiving a secret value. This command prompts for Touch ID or the macOS login password, and prints only variable names:

```sh
node bin/list-source-vault-names.mjs
```

The resulting names are for project inspection and user discussion only. Before a name can be copied into a particular project's `.env`, the user must explicitly approve that exact project and name, then use the provisioning command below. Name discovery never grants provisioning approval.

After the user has explicitly approved the exact project and variable names, provision its local `.env`:

```sh
node bin/provision-project-env.mjs \
  --confirm --project /absolute/path/to/project --project-id project-name \
  OPENAI_API_KEY
```

The helper unlocks only the Keychain source item, selects the named values inside the trusted binary, and updates only those names in the project's `.env`. The `.env` file is replaced atomically with owner-only permissions and must be ignored by Git. Provisioning fails closed outside a Git worktree or when `.env` is not ignored. Values that cannot be represented safely in `.env` are refused without changing the file. A Keychain ACL restricts source-vault access to the fixed helper binaries, and whole-source-vault output is disabled.

Run the project normally:

```sh
cd /absolute/path/to/project
npm run dev
```

The project reads its variables from `.env` using its normal dotenv behavior. The shared source vault is read only during provisioning.

Do not migrate or delete any existing secret value without a specific user confirmation. Once every required value is migrated and verified, the plaintext migration source should be removed only with explicit user approval.

## Native macOS app

Secret Vault is installed as a locally signed macOS application:

```sh
open "$HOME/Applications/Secret Vault.app"
```

It opens the vault inside its own native window and keeps the private loopback server alive only while the app is running. Closing the app stops that server.

To keep it beside Chrome, Slack, and other apps:

1. Open Secret Vault.
2. Right-click its Dock icon.
3. Choose **Options → Keep in Dock**.

The app launches the trusted tools from the source folder used when it was built; keep that folder in place. Its app icon and native wrapper sources live under `macos/`.

## Secret Vault browser UI

The local Secret Vault interface can add, rename, replace, delete, selectively reveal, and copy entries in the shared source vault. Values stay masked until a specific key is selected for reveal; copying does not display the value.

Launch it in either of these ways:

```sh
open "./Open Secret Vault.command"
```

or:

```sh
npm start
```

The app opens a temporary `127.0.0.1` address in the default browser. Keep the Terminal window open while using it, then press Control-C to stop the local server.

### What to expect

- **Unlock vault** authenticates with macOS and loads only the variable names for the current window; the local server never caches the whole value bundle.
- **Click a key** requests a fresh macOS authentication for that one named value; click it again to hide it.
- **Copy** requests fresh macOS authentication for that one named value, then places it on the system clipboard without displaying it in the page.
- **Rename** changes only the variable name inside the shared vault; the stored value remains hidden and unchanged.
- **Lock vault** hides the selected value, clears the server's name-only session, and invalidates any in-flight reveal response.
- **Add key** creates a new name and refuses to overwrite an existing one.
- **Replace** accepts a new value and keeps it masked unless that key is explicitly selected.
- **Delete** requires the exact variable name to be typed before the helper removes it.
- After a helper update, the first read or edit may produce both the app's Touch ID/login-password prompt and a macOS Keychain access prompt. Choosing **Always Allow** authorizes only that newly built exact helper binary; the app still requests device-owner authentication for each sensitive operation.
- Rebuilding `bin/vault-admin` changes that binary's identity and can make macOS ask for Keychain access again. The existing trusted `bin/project-keychain` is not rebuilt or replaced by this UI.

The current vault uses a legacy macOS Keychain ACL. The helper requests Touch ID or the login password before each sensitive action, but the Keychain item does not itself enforce that prompt for trusted binaries. See [SECURITY.md](SECURITY.md) for the threat model and release limits.

The server binds only to loopback and opens a one-time, high-entropy launch URL that establishes an HttpOnly, SameSite browser cookie. It validates that cookie, its exact host and origin, and a per-launch session token for every API action. It does not log request bodies, and it sends edited secret values to the native helper over standard input rather than command-line arguments. Reloading or closing the window also locks the name-only vault session.

Never rebuild a helper that already has access to an existing vault without a deliberate trust and recovery plan. The setup command refuses to overwrite either helper.

# Security model and release status

Secret Vault is under security review. Do not describe the current release as having Keychain enforced Touch ID protection for every read.

## What the current design protects

- The source bundle is stored in the user's macOS Keychain, with a legacy access control list that trusts specific helper binaries.
- The helpers request Touch ID or the macOS login password before sensitive operations. The read helper returns only explicitly named values for a project.
- The local browser UI requires a one-time launch capability, an HttpOnly cookie, an exact host and origin, and a session token. It binds only to loopback.
- Provisioned projects receive selected values in an owner-only, Git-ignored `.env`. That file is plaintext by design.

## Limits that matter

- The Keychain item's legacy access control list allows a trusted helper to access it without a separate Keychain prompt. User presence is requested by helper code, not enforced by the item. A compromised helper process is outside the protection of that application-level prompt. Apple's [Keychain access control documentation](https://developer.apple.com/documentation/security/ksecattraccess) explains the distinction.
- Source changes to a helper are not active in an existing installation until that helper is deliberately rebuilt and trusted again. The setup command never replaces a trusted binary.
- A copied secret remains on the system clipboard until another application replaces it. A revealed value remains in the current page's memory until hidden or the page closes.
- Any process running as the same user can read a provisioned project's `.env`. This tool is not a defense against compromise of that project or user account.
- The original local development history contains old machine paths and a personal author email. Publish only a fresh source snapshot with new history. Do not include the local private folders or compiled helper binaries.

## Stronger Keychain protection

Apple documents `kSecAttrAccessControl` with `userPresence` for Keychain enforced authentication. On this Mac, disposable ad hoc signed probes returned `errSecMissingEntitlement` when attempting to add such an item, both as a command line tool and inside an app bundle. Apple states that data protection Keychain access groups come from authorized signing entitlements in [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains). A migration to this model needs an appropriate signing and provisioning setup, a disposable end-to-end test, and explicit approval before any live source item changes.

No live secret value was read, changed, or copied during the review. See the local ignored audit report for test evidence and outstanding release gates.

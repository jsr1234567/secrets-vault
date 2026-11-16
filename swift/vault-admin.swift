import Darwin
import Foundation
import LocalAuthentication
import Security

#if VAULT_KEYCHAIN_TEST
let service = ProcessInfo.processInfo.environment["VAULT_TEST_SERVICE"] ?? "org.secret-vault.audit.unconfigured"
#else
let service = "com.js.project-secrets"
#endif
let sourceAccount = "vault:global"

struct Entry {
  var name: String
  var value: Data
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
  exit(1)
}

func securityMessage(_ status: OSStatus) -> String {
  (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
}

func validateName(_ name: String) {
  guard name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else {
    fail("Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.")
  }
  guard name.count <= 160 else {
    fail("Variable names must be 160 characters or fewer.")
  }
}

func validateSecret(_ data: Data) {
  guard !data.isEmpty else { fail("Secret values cannot be empty.") }
  guard data.count <= 65_536 else { fail("Secret values must be 64 KB or smaller.") }
  guard !data.contains(0x00), !data.contains(0x0A), !data.contains(0x0D) else {
    fail("Secret values must fit on one line and cannot contain null bytes.")
  }
  guard String(data: data, encoding: .utf8) != nil else {
    fail("Secret values must be valid UTF-8 text.")
  }
}

enum VaultLockError: Error {
  case unsafeDirectory
  case unsafeFile
  case unavailable
}

final class VaultMutationLock {
  private let descriptor: Int32

  init(directory: URL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Secret Vault", isDirectory: true)) throws {
    try FileManager.default.createDirectory(
      at: directory.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    if mkdir(directory.path, 0o700) != 0 && errno != EEXIST {
      throw VaultLockError.unsafeDirectory
    }

    let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directoryDescriptor >= 0 else { throw VaultLockError.unsafeDirectory }
    defer { close(directoryDescriptor) }

    var directoryInfo = stat()
    guard fstat(directoryDescriptor, &directoryInfo) == 0,
          directoryInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
          directoryInfo.st_uid == getuid(),
          directoryInfo.st_mode & 0o022 == 0 else {
      throw VaultLockError.unsafeDirectory
    }

    var fd: Int32 = -1
    for _ in 0..<5 {
      fd = openat(directoryDescriptor, "vault.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
      if fd >= 0 || (errno != ENOENT && errno != EEXIST) { break }
      usleep(10_000)
    }
    guard fd >= 0 else { throw NSError(domain: "VaultLockOpen", code: Int(errno)) }

    var fileInfo = stat()
    guard fstat(fd, &fileInfo) == 0,
          fileInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          fileInfo.st_uid == getuid(),
          fileInfo.st_nlink == 1 else {
      close(fd)
      throw VaultLockError.unsafeFile
    }
    guard fchmod(fd, 0o600) == 0 else {
      let failure = NSError(domain: "VaultLockPermissions", code: Int(errno))
      close(fd)
      throw failure
    }

    while flock(fd, LOCK_EX) != 0 {
      if errno == EINTR { continue }
      close(fd)
      throw VaultLockError.unavailable
    }
    descriptor = fd
  }

  deinit {
    flock(descriptor, LOCK_UN)
    close(descriptor)
  }
}

func baseQuery() -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: sourceAccount,
  ]
}

func authenticate(_ prompt: String) {
  #if VAULT_KEYCHAIN_TEST
  return
  #else
  let context = LAContext()
  var policyError: NSError?
  guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
    fail(policyError?.localizedDescription ?? "Touch ID or the macOS login password is unavailable.")
  }

  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<Void, Error> = .failure(NSError(domain: "VaultAdmin", code: 1))
  context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) { success, error in
    result = success ? .success(()) : .failure(error ?? NSError(domain: "VaultAdmin", code: 1))
    semaphore.signal()
  }
  semaphore.wait()

  if case let .failure(error) = result {
    fail(error.localizedDescription)
  }
  #endif
}

func readBundle() -> Data? {
  var query = baseQuery()
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne

  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { return nil }
  guard status == errSecSuccess else { fail(securityMessage(status)) }
  guard let bundle = result as? Data else { fail("Keychain returned an unexpected value.") }
  return bundle
}

func trustedApplication(_ executablePath: String) -> SecTrustedApplication {
  var application: SecTrustedApplication?
  let status = executablePath.withCString {
    SecTrustedApplicationCreateFromPath($0, &application)
  }
  guard status == errSecSuccess, let application else {
    fail("Could not create a Keychain trust record: \(securityMessage(status))")
  }
  return application
}

func trustedAccess() -> SecAccess {
  let currentExecutable = CommandLine.arguments[0]
  let existingHelper = URL(fileURLWithPath: currentExecutable)
    .deletingLastPathComponent()
    .appendingPathComponent("project-keychain")
    .path
  let applications = [
    trustedApplication(currentExecutable),
    trustedApplication(existingHelper),
  ]

  var access: SecAccess?
  let status = SecAccessCreate(
    "Project secrets vault editors" as CFString,
    applications as CFArray,
    &access
  )
  guard status == errSecSuccess, let access else {
    fail("Could not create a Keychain access list: \(securityMessage(status))")
  }
  return access
}

func parseEntries(_ bundle: Data) -> [Entry] {
  guard !bundle.isEmpty else { fail("The protected vault is empty.") }

  var entries = [Entry]()
  var names = Set<String>()
  let lines = bundle.split(separator: 0x0A, omittingEmptySubsequences: true)

  for line in lines {
    guard let equalIndex = line.firstIndex(of: 0x3D) else {
      fail("The protected vault contains a malformed entry.")
    }

    let nameBytes = line[..<equalIndex]
    let valueStart = line.index(after: equalIndex)
    guard let name = String(bytes: nameBytes, encoding: .utf8) else {
      fail("The protected vault contains an invalid variable name.")
    }
    validateName(name)
    guard names.insert(name).inserted else {
      fail("The protected vault contains a duplicate variable name.")
    }
    entries.append(Entry(name: name, value: Data(line[valueStart...])))
  }

  guard !entries.isEmpty else { fail("The protected vault has no variable entries.") }
  return entries
}

func makeBundle(_ entries: [Entry]) -> Data {
  var bundle = Data()
  for entry in entries {
    bundle.append(contentsOf: entry.name.utf8)
    bundle.append(0x3D)
    bundle.append(entry.value)
    bundle.append(0x0A)
  }
  return bundle
}

func updateBundle(_ bundle: Data) {
  let attributes = [kSecValueData as String: bundle]
  let status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
  guard status == errSecSuccess else { fail(securityMessage(status)) }
}

func addBundle(_ bundle: Data) {
  var query = baseQuery()
  query[kSecAttrLabel as String] = "Project secrets (source-vault approval required)"
  query[kSecAttrAccess as String] = trustedAccess()
  query[kSecValueData as String] = bundle
  let status = SecItemAdd(query as CFDictionary, nil)
  if status == errSecDuplicateItem {
    fail("The source vault was created by another process. Try again.")
  }
  guard status == errSecSuccess else { fail(securityMessage(status)) }
}

func wipe(_ entries: inout [Entry]) {
  for index in entries.indices {
    entries[index].value.resetBytes(in: 0..<entries[index].value.count)
  }
}

func runSelfTest() {
  let sample = Data("ALPHA=one\nBETA=two=parts\n".utf8)
  var entries = parseEntries(sample)
  entries[0].name = "RENAMED_ALPHA"
  let renamedSample = Data("RENAMED_ALPHA=one\nBETA=two=parts\n".utf8)
  guard entries.count == 2,
        entries[0].name == "RENAMED_ALPHA",
        String(data: entries[1].value, encoding: .utf8) == "two=parts",
        makeBundle(entries) == renamedSample else {
    fail("Self-test failed.")
  }
  wipe(&entries)
  FileHandle.standardOutput.write(Data("ok\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
#if VAULT_KEYCHAIN_TEST
guard service.hasPrefix("org.secret-vault.audit.") else { fail("Unsafe fixture service.") }
if arguments == ["purge-fixture"] {
  let status = SecItemDelete(baseQuery() as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { fail(securityMessage(status)) }
  exit(0)
}
#endif
#if VAULT_LOCK_TEST
if arguments.count == 3, arguments[0] == "lock-test" {
  do {
    let lock = try VaultMutationLock(directory: URL(fileURLWithPath: arguments[1], isDirectory: true))
    let counter = URL(fileURLWithPath: arguments[2])
    let current = Int((try? String(contentsOf: counter, encoding: .utf8)) ?? "0") ?? 0
    usleep(5_000)
    try String(current + 1).write(to: counter, atomically: true, encoding: .utf8)
    withExtendedLifetime(lock) {}
    exit(0)
  } catch {
    fail("Lock self-test failed: \(error)")
  }
}
#endif
if arguments == ["capabilities"] {
  FileHandle.standardOutput.write(Data("scoped-read-v1\n".utf8))
  exit(0)
}
if arguments == ["self-test"] {
  runSelfTest()
  exit(0)
}

if arguments == ["list-names"] {
  authenticate("List the variable names in the shared source vault. No values will be shown.")
  var bundle = readBundle() ?? Data()
  defer { bundle.resetBytes(in: 0..<bundle.count) }
  if bundle.isEmpty {
    exit(0)
  }
  var entries = parseEntries(bundle)
  defer { wipe(&entries) }
  let names = entries.map(\.name).joined(separator: "\n")
  FileHandle.standardOutput.write(Data((names + "\n").utf8))
  exit(0)
}

if arguments.count == 2, arguments[0] == "reveal" {
  let variableName = arguments[1]
  validateName(variableName)
  authenticate("Reveal only \(variableName) from the shared source vault.")
  var bundle = readBundle() ?? Data()
  defer { bundle.resetBytes(in: 0..<bundle.count) }
  guard !bundle.isEmpty else { fail("\(variableName) does not exist.") }
  var entries = parseEntries(bundle)
  defer { wipe(&entries) }
  guard let entry = entries.first(where: { $0.name == variableName }) else {
    fail("\(variableName) does not exist.")
  }
  FileHandle.standardOutput.write(entry.value)
  exit(0)
}

guard let command = arguments.first,
      ["create", "replace", "rename", "delete"].contains(command) else {
  fail("Unknown command.")
}
if command == "rename" {
  guard arguments.count == 3 else {
    fail("Usage: vault-admin rename CURRENT_NAME NEW_NAME")
  }
} else {
  guard arguments.count == 2 else {
    fail("Usage: vault-admin create|replace|delete VARIABLE_NAME")
  }
}

let variableName = arguments[1]
validateName(variableName)
let newVariableName = command == "rename" ? arguments[2] : ""
if command == "rename" {
  validateName(newVariableName)
  guard newVariableName != variableName else {
    fail("Choose a different variable name.")
  }
}

let action: String
switch command {
case "create":
  action = "Add \(variableName) to the shared source vault."
case "replace":
  action = "Replace \(variableName) in the shared source vault."
case "rename":
  action = "Rename \(variableName) to \(newVariableName) in the shared source vault."
default:
  action = "Delete \(variableName) from the shared source vault."
}
authenticate(action)

let mutationLock: VaultMutationLock
do {
  #if VAULT_KEYCHAIN_TEST
  guard let lockPath = ProcessInfo.processInfo.environment["VAULT_TEST_LOCK_DIR"] else {
    fail("Missing fixture lock directory.")
  }
  mutationLock = try VaultMutationLock(directory: URL(fileURLWithPath: lockPath, isDirectory: true))
  #else
  mutationLock = try VaultMutationLock()
  #endif
} catch {
  fail("Could not secure the vault mutation lock.")
}

var originalBundle = readBundle() ?? Data()
let vaultExisted = !originalBundle.isEmpty
var entries = vaultExisted ? parseEntries(originalBundle) : []
defer {
  originalBundle.resetBytes(in: 0..<originalBundle.count)
  wipe(&entries)
}

let existingIndex = entries.firstIndex { $0.name == variableName }

switch command {
case "create":
  guard existingIndex == nil else { fail("\(variableName) already exists.") }
  var newValue = FileHandle.standardInput.readDataToEndOfFile()
  defer { newValue.resetBytes(in: 0..<newValue.count) }
  validateSecret(newValue)
  entries.append(Entry(name: variableName, value: newValue))

case "replace":
  guard let index = existingIndex else { fail("\(variableName) does not exist.") }
  var newValue = FileHandle.standardInput.readDataToEndOfFile()
  defer { newValue.resetBytes(in: 0..<newValue.count) }
  validateSecret(newValue)
  entries[index].value.resetBytes(in: 0..<entries[index].value.count)
  entries[index].value = newValue

case "rename":
  guard let index = existingIndex else { fail("\(variableName) does not exist.") }
  guard !entries.contains(where: { $0.name == newVariableName }) else {
    fail("\(newVariableName) already exists.")
  }
  entries[index].name = newVariableName

case "delete":
  guard let index = existingIndex else { fail("\(variableName) does not exist.") }
  entries[index].value.resetBytes(in: 0..<entries[index].value.count)
  entries.remove(at: index)

default:
  fail("Unknown command.")
}

if entries.isEmpty {
  let status = SecItemDelete(baseQuery() as CFDictionary)
  guard status == errSecSuccess else { fail(securityMessage(status)) }
} else {
  var updatedBundle = makeBundle(entries)
  defer { updatedBundle.resetBytes(in: 0..<updatedBundle.count) }
  if vaultExisted {
    updateBundle(updatedBundle)
  } else {
    addBundle(updatedBundle)
  }
}

FileHandle.standardOutput.write(Data("ok\n".utf8))
withExtendedLifetime(mutationLock) {}

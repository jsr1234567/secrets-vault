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
  let name: String
  var value: Data
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
  exit(1)
}

func securityMessage(_ status: OSStatus) -> String {
  (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
}

func validateAccount(_ account: String) {
  guard account.range(of: "^[a-z0-9][a-z0-9:_-]{2,180}$", options: .regularExpression) != nil else {
    fail("Invalid project account identifier.")
  }
}

func validateName(_ name: String) {
  guard name.count <= 160,
        name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else {
    fail("Invalid environment variable name.")
  }
}

func validateProjectId(_ projectId: String) {
  guard projectId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil else {
    fail("Invalid project identifier.")
  }
}

func canonicalProjectPath(_ projectPath: String) -> String {
  guard projectPath.hasPrefix("/") else { fail("Project path must be absolute.") }
  let forbiddenScalars = projectPath.unicodeScalars.contains { scalar in
    CharacterSet.controlCharacters.contains(scalar)
      || CharacterSet.illegalCharacters.contains(scalar)
      || (0x202A...0x202E).contains(scalar.value)
      || (0x2066...0x2069).contains(scalar.value)
  }
  guard !forbiddenScalars else { fail("Project path contains unsafe display characters.") }

  guard let resolved = realpath(projectPath, nil) else {
    fail("Project path must identify an existing directory.")
  }
  defer { free(resolved) }
  let canonical = String(cString: resolved)
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: canonical, isDirectory: &isDirectory),
        isDirectory.boolValue else {
    fail("Project path must identify an existing directory.")
  }
  guard projectPath == canonical else { fail("Project path must already be canonical.") }
  return canonical
}

func parseEntries(_ bundle: Data) -> [Entry] {
  guard !bundle.isEmpty else { fail("The protected vault is empty.") }

  var entries = [Entry]()
  var names = Set<String>()
  for line in bundle.split(separator: 0x0A, omittingEmptySubsequences: true) {
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

func makeSelectedBundle(_ entries: [Entry], names: [String]) -> Data {
  let entriesByName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0.value) })
  let missing = names.filter { entriesByName[$0] == nil }
  guard missing.isEmpty else {
    fail("Missing required variable names in the source vault: \(missing.joined(separator: ", "))")
  }

  var selected = Data()
  for name in names {
    selected.append(contentsOf: name.utf8)
    selected.append(0x3D)
    selected.append(entriesByName[name]!)
    selected.append(0x0A)
  }
  return selected
}

func wipe(_ entries: inout [Entry]) {
  for index in entries.indices {
    entries[index].value.resetBytes(in: 0..<entries[index].value.count)
  }
}

func variableNames(in bundle: Data) -> [String] {
  guard !bundle.isEmpty else { fail("Secret bundle must be non-empty UTF-8 text.") }

  var names = Set<String>()
  var orderedNames = [String]()
  for line in bundle.split(separator: 0x0A, omittingEmptySubsequences: true) {
    guard let equalIndex = line.firstIndex(of: 0x3D) else {
      fail("Secret bundle contains a malformed environment entry.")
    }
    let nameBytes = line[..<equalIndex]
    guard let name = String(bytes: nameBytes, encoding: .utf8),
          name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil,
          names.insert(name).inserted else {
      fail("Secret bundle contains an invalid or duplicate variable name.")
    }
    orderedNames.append(name)
  }
  guard !orderedNames.isEmpty else { fail("Secret bundle must contain at least one variable name.") }
  return orderedNames
}

func readBundle(_ account: String) -> Data {
  var query = baseQuery(account)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne

  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess else { fail(securityMessage(status)) }
  guard let bundle = result as? Data else { fail("Keychain returned an unexpected value.") }
  return bundle
}

func baseQuery(_ account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
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
  var result: Result<Void, Error> = .failure(NSError(domain: "ProjectKeychain", code: 1))
  context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) { success, error in
    result = success ? .success(()) : .failure(error ?? NSError(domain: "ProjectKeychain", code: 1))
    semaphore.signal()
  }
  semaphore.wait()
  if case let .failure(error) = result {
    fail(error.localizedDescription)
  }
  #endif
}

func runSelfTest() {
  var entries = parseEntries(Data("ALPHA=one\nBETA=two=parts\n".utf8))
  var selected = makeSelectedBundle(entries, names: ["BETA"])
  defer {
    selected.resetBytes(in: 0..<selected.count)
    wipe(&entries)
  }
  guard selected == Data("BETA=two=parts\n".utf8) else { fail("Self-test failed.") }
  FileHandle.standardOutput.write(Data("ok\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
#if VAULT_KEYCHAIN_TEST
guard service.hasPrefix("org.secret-vault.audit.") else { fail("Unsafe fixture service.") }
#endif
if arguments == ["capabilities"] {
  FileHandle.standardOutput.write(Data("selected-read-v1\n".utf8))
  exit(0)
}
if arguments == ["self-test"] {
  runSelfTest()
  exit(0)
}
guard arguments.count >= 2 else {
  fail("Usage: project-keychain read-selected|list-names ...")
}

let command = arguments[0]
let account = arguments[1]
validateAccount(account)

switch command {
case "read-selected":
  guard account == sourceAccount, arguments.count >= 5 else {
    fail("Usage: project-keychain read-selected vault:global PROJECT_ID /canonical/project/path VARIABLE [VARIABLE ...]")
  }
  let projectId = arguments[2]
  let projectPath = arguments[3]
  let names = Array(arguments.dropFirst(4))
  validateProjectId(projectId)
  let canonicalPath = canonicalProjectPath(projectPath)
  guard names.count <= 32, Set(names).count == names.count else {
    fail("Request between 1 and 32 unique variable names.")
  }
  for name in names { validateName(name) }

  let reason = """
  Approve \(names.count) secret(s) for project \(projectId).
  Path: \(canonicalPath)
  Names: \(names.joined(separator: ", "))
  """
  guard reason.utf8.count <= 900 else {
    fail("The approval summary is too long. Request fewer names at once.")
  }
  authenticate(reason)

  var bundle = readBundle(account)
  var entries = parseEntries(bundle)
  var selected = makeSelectedBundle(entries, names: names)
  defer {
    bundle.resetBytes(in: 0..<bundle.count)
    selected.resetBytes(in: 0..<selected.count)
    wipe(&entries)
  }
  FileHandle.standardOutput.write(selected)

case "list-names":
  guard arguments.count == 2, account == sourceAccount else {
    fail("Usage: project-keychain list-names vault:global")
  }
  authenticate("List the variable names in the shared source vault. No values will be shown.")
  var bundle = readBundle(account)
  defer { bundle.resetBytes(in: 0..<bundle.count) }
  let names = variableNames(in: bundle)
  FileHandle.standardOutput.write(Data((names.joined(separator: "\n") + "\n").utf8))

default:
  fail("Unknown command: \(command)")
}

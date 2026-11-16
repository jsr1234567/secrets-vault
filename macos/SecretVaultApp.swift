import AppKit
import WebKit

private let projectRoot = Bundle.main.object(forInfoDictionaryKey: "VaultProjectRoot") as? String ?? ""
private let serverPath = "\(projectRoot)/app/server.mjs"

@main
struct SecretVaultApplication {
  static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var serverProcess: Process?
  private var allowedServerPort: Int?
  private let outputQueue = DispatchQueue(label: "com.js.secret-vault.server-output")
  private var outputBuffer = ""
  private var appIsTerminating = false
  private var serverIsReady = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    installMenus()
    createWindow()
    showLoadingScreen()
    startServer()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    appIsTerminating = true
    stopServer()
  }

  private func installMenus() {
    let mainMenu = NSMenu()

    let applicationItem = NSMenuItem()
    let applicationMenu = NSMenu()
    applicationMenu.addItem(
      withTitle: "About Secret Vault",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    applicationMenu.addItem(.separator())
    applicationMenu.addItem(
      withTitle: "Hide Secret Vault",
      action: #selector(NSApplication.hide(_:)),
      keyEquivalent: "h"
    )
    applicationMenu.addItem(
      withTitle: "Hide Others",
      action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h"
    ).keyEquivalentModifierMask = [.command, .option]
    applicationMenu.addItem(
      withTitle: "Show All",
      action: #selector(NSApplication.unhideAllApplications(_:)),
      keyEquivalent: ""
    )
    applicationMenu.addItem(.separator())
    applicationMenu.addItem(
      withTitle: "Quit Secret Vault",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )
    applicationItem.submenu = applicationMenu
    mainMenu.addItem(applicationItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      withTitle: "Minimize",
      action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m"
    )
    windowMenu.addItem(
      withTitle: "Zoom",
      action: #selector(NSWindow.performZoom(_:)),
      keyEquivalent: ""
    )
    windowMenu.addItem(.separator())
    windowMenu.addItem(
      withTitle: "Bring All to Front",
      action: #selector(NSApplication.arrangeInFront(_:)),
      keyEquivalent: ""
    )
    windowItem.submenu = windowMenu
    mainMenu.addItem(windowItem)
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = mainMenu
  }

  private func createWindow() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Secret Vault"
    window.minSize = NSSize(width: 760, height: 560)
    window.contentView = webView
    window.center()
    window.makeKeyAndOrderFront(nil)
  }

  private func showLoadingScreen() {
    let html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="color-scheme" content="light dark">
        <style>
          :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
          body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0d0f13; color: #eef0f4; }
          main { display: grid; justify-items: center; gap: 14px; text-align: center; }
          .mark { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 15px; background: #526ee8; box-shadow: 0 18px 40px rgba(30, 51, 128, .28); }
          svg { width: 30px; height: 30px; fill: none; stroke: white; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
          h1 { margin: 0; font-size: 17px; letter-spacing: -.01em; }
          p { margin: 0; color: #a5acb9; font-size: 13px; }
        </style>
      </head>
      <body>
        <main>
          <div class="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect width="15" height="14" x="4.5" y="5" rx="3"/><path d="M8 10h8M8 15h8"/><circle cx="12" cy="12.5" r="1.5"/></svg>
          </div>
          <h1>Opening Secret Vault</h1>
          <p>Starting the private local connection…</p>
        </main>
      </body>
    </html>
    """
    webView.loadHTMLString(html, baseURL: nil)
  }

  private func showErrorScreen() {
    let html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="color-scheme" content="light dark">
        <style>
          :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
          body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0d0f13; color: #eef0f4; }
          main { max-width: 420px; padding: 32px; text-align: center; }
          h1 { margin: 0 0 10px; font-size: 19px; }
          p { margin: 0; color: #a5acb9; font-size: 13px; line-height: 1.55; }
          code { color: #b7c3ff; }
        </style>
      </head>
      <body>
        <main>
          <h1>Secret Vault couldn’t start</h1>
          <p>Confirm that the source folder used to build this app still exists, then reopen it.</p>
        </main>
      </body>
    </html>
    """
    webView.loadHTMLString(html, baseURL: nil)
  }

  private func nodeExecutable() -> URL? {
    let candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]
    return candidates.first(where: nodeRuns(atPath:)).map(URL.init(fileURLWithPath:))
  }

  // Skip a Node that exists but cannot run, such as one broken by a Homebrew library update.
  private func nodeRuns(atPath path: String) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: path) else { return false }
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: path)
    probe.arguments = ["-e", ""]
    probe.standardOutput = FileHandle.nullDevice
    probe.standardError = FileHandle.nullDevice
    do {
      try probe.run()
    } catch {
      return false
    }
    probe.waitUntilExit()
    return probe.terminationStatus == 0
  }

  private func startServer() {
    guard FileManager.default.fileExists(atPath: serverPath),
          let nodeURL = nodeExecutable() else {
      showErrorScreen()
      return
    }

    let process = Process()
    let output = Pipe()
    let errors = Pipe()
    process.executableURL = nodeURL
    process.arguments = [serverPath]
    process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
    process.environment = [
      "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "LANG": "en_US.UTF-8",
    ]
    process.standardOutput = output
    process.standardError = errors

    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      self?.consumeServerOutput(data)
    }
    errors.fileHandleForReading.readabilityHandler = { handle in
      _ = handle.availableData
    }

    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, !self.appIsTerminating, !self.serverIsReady else { return }
        self.showErrorScreen()
      }
    }

    do {
      try process.run()
      serverProcess = process
    } catch {
      showErrorScreen()
    }
  }

  private func consumeServerOutput(_ data: Data) {
    outputQueue.async { [weak self] in
      guard let self, let chunk = String(data: data, encoding: .utf8) else { return }
      self.outputBuffer.append(chunk)

      while let newline = self.outputBuffer.firstIndex(of: "\n") {
        let line = String(self.outputBuffer[..<newline])
        self.outputBuffer.removeSubrange(...newline)
        self.handleServerLine(line)
      }
    }
  }

  private func handleServerLine(_ line: String) {
    let prefix = "Secret Vault is ready at "
    guard line.hasPrefix(prefix) else { return }
    let address = String(line.dropFirst(prefix.count))
    guard let url = URL(string: address),
          url.scheme == "http",
          url.host == "127.0.0.1",
          let port = url.port else { return }

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.serverIsReady = true
      self.allowedServerPort = port
      self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
  }

  private func stopServer() {
    guard let process = serverProcess, process.isRunning else { return }
    process.terminate()
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }

    if url.scheme == "about" ||
        (url.scheme == "http" && url.host == "127.0.0.1" && url.port == allowedServerPort) {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
    }
  }
}

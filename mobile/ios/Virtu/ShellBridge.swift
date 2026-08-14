import UIKit
import WebKit

/// The native half of bridge protocol v1 (client/src/shell.md): a
/// `WKScriptMessageHandlerWithReply` in the page content world, plus the
/// document-start shim that presents the uniform `window.virtuShell`.
/// Message parsing/serialization lives in `ShellProtocol`; this class is
/// only the WebKit/UIKit glue.
final class ShellBridge: NSObject, WKScriptMessageHandlerWithReply {
  static let handlerName = "virtuShell"

  private let keychain: KeychainStore
  private weak var presenter: UIViewController?
  private weak var userContentController: WKUserContentController?
  private let shimSource: String?

  init(keychain: KeychainStore, presenter: UIViewController) {
    self.keychain = keychain
    self.presenter = presenter
    let version =
      (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    if let url = Bundle.main.url(forResource: "shell-bridge", withExtension: "js"),
       let source = try? String(contentsOf: url, encoding: .utf8) {
      shimSource = source.replacingOccurrences(of: "__SHELL_VERSION__", with: version)
    } else {
      // Missing resource: inject nothing — the SPA runs as plain web, the
      // degradation shell.md promises.
      shimSource = nil
    }
    super.init()
  }

  func attach(to controller: WKUserContentController) {
    userContentController = controller
    controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
    refreshUserScripts()
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    // Never reject the JS promise (the second closure argument): shell.md's
    // contract is that errors come back as error replies.
    guard let body = message.body as? String else {
      replyHandler(ShellProtocol.errorReply("bad-payload"), nil)
      return
    }
    switch ShellProtocol.parse(body) {
    case .malformed(let error):
      replyHandler(ShellProtocol.errorReply(error), nil)
    case .request(let command):
      execute(command) { ok in
        replyHandler(ok ? ShellProtocol.okReply() : ShellProtocol.errorReply("failed"), nil)
      }
    }
  }

  private func execute(_ command: ShellProtocol.Command, completion: @escaping (Bool) -> Void) {
    switch command {
    case .storeApiKey(let key):
      let ok = keychain.store(apiKey: key)
      refreshUserScripts()
      completion(ok)

    case .clearApiKey:
      let ok = keychain.clear()
      refreshUserScripts()
      completion(ok)

    case .share(let title, let text, let url):
      guard let presenter else { return completion(false) }
      var items: [Any] = []
      if let title { items.append(title) }
      if let text { items.append(text) }
      if let url, let shareURL = URL(string: url) { items.append(shareURL) }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      // iPad requires a popover anchor or UIKit crashes on present.
      sheet.popoverPresentationController?.sourceView = presenter.view
      sheet.popoverPresentationController?.sourceRect = CGRect(
        x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0
      )
      presenter.present(sheet, animated: true)
      // ok = "sheet presented"; completion/cancel deliberately unreported —
      // the protocol keeps to Android's common denominator (shell.md).
      completion(true)

    case .openExternal(let url):
      UIApplication.shared.open(url, options: [:]) { success in completion(success) }
    }
  }

  /// The localStorage safety net (plans/mobile.md, Auth): WKWebView storage
  /// has documented flakiness across suspensions, so if it was evicted while
  /// the Keychain still holds the key, re-seed at document start instead of
  /// forcing a re-login. Re-registered on every store/clear; takes effect on
  /// the next (re)load, which is exactly when eviction would bite.
  private func refreshUserScripts() {
    guard let controller = userContentController else { return }
    controller.removeAllUserScripts()
    if let shimSource {
      controller.addUserScript(
        WKUserScript(source: shimSource, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
      )
    }
    if let key = keychain.load(), let literal = Self.jsStringLiteral(key) {
      let healing =
        #"if (!localStorage.getItem("virtu.apiKey")) localStorage.setItem("virtu.apiKey", \#(literal));"#
      controller.addUserScript(
        WKUserScript(source: healing, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
      )
    }
  }

  /// A JSON string literal is also a valid JS string literal — safe
  /// interpolation into the healing script.
  private static func jsStringLiteral(_ value: String) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

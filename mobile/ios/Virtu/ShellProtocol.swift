import Foundation

/// Bridge protocol v1, pure message layer — no UIKit/WebKit types, so this
/// runs as a plain XCTest unit. The contract is `client/src/shell.md`; a
/// change to either side is a change to both, in the same review.
///
/// Unlike Android there is no id envelope: on iOS the promise returned by
/// `webkit.messageHandlers.virtuShell.postMessage(...)` IS the reply channel
/// (`WKScriptMessageHandlerWithReply`), so what this layer parses is exactly
/// the JSON message string the shell.md contract defines, and replies are
/// exactly the JSON reply strings.
enum ShellProtocol {
  static let version = 1

  enum Command: Equatable {
    case storeApiKey(key: String)
    case clearApiKey
    case share(title: String?, text: String?, url: String?)
    case openExternal(url: URL)
  }

  enum Inbound: Equatable {
    case request(Command)
    /// `error` is the shell.md slug: `bad-payload` / `unknown-message`.
    case malformed(error: String)
  }

  static func parse(_ messageJSON: String) -> Inbound {
    guard
      let data = messageJSON.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let type = object["type"] as? String
    else { return .malformed(error: "bad-payload") }

    switch type {
    case "apiKey.store":
      guard let key = object["key"] as? String, !key.isEmpty else {
        return .malformed(error: "bad-payload")
      }
      return .request(.storeApiKey(key: key))

    case "apiKey.clear":
      return .request(.clearApiKey)

    case "share":
      let title = object["title"] as? String
      let text = object["text"] as? String
      let url = object["url"] as? String
      guard text != nil || url != nil else { return .malformed(error: "bad-payload") }
      return .request(.share(title: title, text: text, url: url))

    case "external.open":
      guard
        let raw = object["url"] as? String,
        raw.lowercased().hasPrefix("https://") || raw.lowercased().hasPrefix("http://"),
        let url = URL(string: raw)
      else { return .malformed(error: "bad-payload") }
      return .request(.openExternal(url: url))

    default:
      // Forward compatibility: a newer web app must get unknown-message
      // back, never a crash or a dropped reply (shell.md, versioning).
      return .malformed(error: "unknown-message")
    }
  }

  static func okReply() -> String { #"{"ok":true}"# }

  /// `error` is always one of the fixed shell.md slugs — no escaping needed.
  static func errorReply(_ error: String) -> String {
    #"{"ok":false,"error":"\#(error)"}"#
  }
}

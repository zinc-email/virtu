import XCTest
@testable import Virtu

/// Protocol v1 conformance against client/src/shell.md — mirrors the Android
/// suite (ShellProtocolTest.kt) minus the id envelope, which iOS doesn't have.
final class ShellProtocolTests: XCTestCase {
  func testApiKeyStoreCarriesTheKey() {
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"apiKey.store","key":"sk-123"}"#),
      .request(.storeApiKey(key: "sk-123"))
    )
  }

  func testApiKeyStoreWithoutAKeyIsBadPayload() {
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"apiKey.store"}"#),
      .malformed(error: "bad-payload")
    )
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"apiKey.store","key":""}"#),
      .malformed(error: "bad-payload")
    )
  }

  func testApiKeyClearHasNoFields() {
    XCTAssertEqual(ShellProtocol.parse(#"{"type":"apiKey.clear"}"#), .request(.clearApiKey))
  }

  func testShareNeedsAtLeastOneOfTextOrUrl() {
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"share","url":"https://x.test/"}"#),
      .request(.share(title: nil, text: nil, url: "https://x.test/"))
    )
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"share","title":"t","text":"body"}"#),
      .request(.share(title: "t", text: "body", url: nil))
    )
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"share","title":"only a title"}"#),
      .malformed(error: "bad-payload")
    )
  }

  func testExternalOpenTakesHttpAndHttpsOnly() {
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"external.open","url":"https://docs.example/page"}"#),
      .request(.openExternal(url: URL(string: "https://docs.example/page")!))
    )
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"external.open","url":"javascript:alert(1)"}"#),
      .malformed(error: "bad-payload")
    )
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"external.open"}"#),
      .malformed(error: "bad-payload")
    )
  }

  func testUnknownTypeGetsTheUnknownMessageSlug() {
    // Forward compatibility: a newer web app talking to this older shell
    // must get unknown-message back, never a crash or a dropped reply.
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"push.register"}"#),
      .malformed(error: "unknown-message")
    )
  }

  func testUnreadableMessageIsBadPayload() {
    XCTAssertEqual(ShellProtocol.parse("not json"), .malformed(error: "bad-payload"))
    XCTAssertEqual(ShellProtocol.parse("[1,2,3]"), .malformed(error: "bad-payload"))
    XCTAssertEqual(ShellProtocol.parse("{}"), .malformed(error: "bad-payload"))
  }

  func testExtraFieldsAreTolerated() {
    // A newer web app may add optional fields; protocol v1 shells must not
    // reject on their presence.
    XCTAssertEqual(
      ShellProtocol.parse(#"{"type":"apiKey.clear","reason":"logout"}"#),
      .request(.clearApiKey)
    )
  }

  func testRepliesAreTheContractJSON() throws {
    let ok = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(ShellProtocol.okReply().utf8)) as? [String: Any]
    )
    XCTAssertEqual(ok["ok"] as? Bool, true)
    XCTAssertNil(ok["error"])

    let err = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(ShellProtocol.errorReply("failed").utf8)) as? [String: Any]
    )
    XCTAssertEqual(err["ok"] as? Bool, false)
    XCTAssertEqual(err["error"] as? String, "failed")
  }
}

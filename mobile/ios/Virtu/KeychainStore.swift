import Foundation
import Security

/// The API key at rest: a Keychain generic-password item (plans/mobile.md,
/// Auth). The entitlements file declares the shared access group
/// (`…email.zinc.virtu.shared`) and, as the FIRST group listed, it is the
/// default for items created without an explicit kSecAttrAccessGroup — which
/// is why none is set here (setting one explicitly breaks unsigned simulator
/// builds). The future share extension and credential provider (Tracks D/G)
/// read the key from that same group.
final class KeychainStore {
  private let service = "email.zinc.virtu"
  private let account = "api-key"

  private var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  @discardableResult
  func store(apiKey: String) -> Bool {
    guard let data = apiKey.data(using: .utf8) else { return false }
    SecItemDelete(baseQuery as CFDictionary)
    var attributes = baseQuery
    attributes[kSecValueData as String] = data
    // AfterFirstUnlock: the extensions may need the key while the app is
    // backgrounded; device-locked-since-boot is the only excluded state.
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
  }

  func load() -> String? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  @discardableResult
  func clear() -> Bool {
    let status = SecItemDelete(baseQuery as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}

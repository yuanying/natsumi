import CryptoKit
import Foundation
import Security

/// This iPhone's key for opening notifications, in the Keychain the app and its Notification Service Extension
/// share (ADR 0029). The server has only the public half.
public struct PushKeyStore: Sendable {
    public let service: String
    /// The Keychain access group both targets are entitled to, or nil for the caller's default group.
    public let accessGroup: String?
    private static let account = "device-key"

    public init(service: String = "io.github.yuanying.natsumi.push", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// The shared access group named in the bundle's Info.plist (`NatsumiKeychainGroup`), with the team prefix
    /// already filled in by the build.
    public static func sharedGroup(in bundle: Bundle = .main) -> String? {
        bundle.object(forInfoDictionaryKey: "NatsumiKeychainGroup") as? String
    }

    private var query: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func load() throws -> P256.KeyAgreement.PrivateKey? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PushKeyError(status: status) }
        return try P256.KeyAgreement.PrivateKey(rawRepresentation: data)
    }

    /// The key there is, or a new one kept for next time. The key stays for good: a new one would leave the
    /// notifications already sealed to the old one unreadable.
    public func loadOrCreate() throws -> P256.KeyAgreement.PrivateKey {
        if let key = try load() { return key }
        let key = P256.KeyAgreement.PrivateKey()
        var item = query
        item[kSecValueData as String] = key.rawRepresentation
        #if os(iOS)
        // The extension opens notifications while the phone is locked.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #endif
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw PushKeyError(status: status) }
        return key
    }

    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PushKeyError(status: status) }
    }
}

public struct PushKeyError: Error, Equatable {
    public let status: OSStatus
}

import Foundation
import Security

/// Where secrets go. The session token is written only through this.
public protocol SecretStore: Sendable {
    func read(account: String) throws -> Data?
    func write(_ data: Data, account: String) throws
    func delete(account: String) throws
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// Generic passwords in the login keychain.
public struct KeychainSecretStore: SecretStore {
    public let service: String

    public init(service: String = "io.github.yuanying.natsumi") {
        self.service = service
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func read(account: String) throws -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return result as? Data
    }

    public func write(_ data: Data, account: String) throws {
        let update = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError(status: update) }
        var item = query(account)
        item[kSecValueData as String] = data
        let add = SecItemAdd(item as CFDictionary, nil)
        guard add == errSecSuccess else { throw KeychainError(status: add) }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// The account on this Mac: the server origin and device ID in preferences, the session only in the secret store.
public final class AccountStore: @unchecked Sendable {
    /// Every key this store writes to preferences. None of them holds a secret.
    public static let preferenceKeys = ["serverOrigin", "deviceId"]
    private static let sessionAccount = "session"

    private let secrets: SecretStore
    private let defaults: UserDefaults

    public init(secrets: SecretStore, defaults: UserDefaults) {
        self.secrets = secrets
        self.defaults = defaults
    }

    /// Changing the server forgets the previous server's session and device registration.
    public var serverAddress: ServerAddress? {
        get { defaults.string(forKey: "serverOrigin").flatMap { try? ServerAddress($0) } }
        set {
            let previous = serverAddress
            if let newValue {
                defaults.set(newValue.origin.absoluteString, forKey: "serverOrigin")
            } else {
                defaults.removeObject(forKey: "serverOrigin")
            }
            if previous != newValue {
                deviceId = nil
                clearSession()
            }
        }
    }

    public var deviceId: String? {
        get { defaults.string(forKey: "deviceId") }
        set {
            if let newValue { defaults.set(newValue, forKey: "deviceId") } else { defaults.removeObject(forKey: "deviceId") }
        }
    }

    public func saveSession(_ grant: SessionGrant) throws {
        try secrets.write(JSONEncoder().encode(grant), account: Self.sessionAccount)
    }

    /// The saved session while it is valid. An expired one is deleted.
    public func session(at now: Date = Date()) -> SessionGrant? {
        guard let data = try? secrets.read(account: Self.sessionAccount),
              let grant = try? JSONDecoder().decode(SessionGrant.self, from: data)
        else { return nil }
        if grant.isExpired(at: now) {
            clearSession()
            return nil
        }
        return grant
    }

    public func clearSession() {
        try? secrets.delete(account: Self.sessionAccount)
    }
}

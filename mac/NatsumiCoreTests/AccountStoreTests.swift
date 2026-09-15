import Foundation
import Testing
@testable import NatsumiCore

@Suite("保存の境界: トークンは秘密の保存先にだけ置く", .serialized)
struct AccountStoreTests {
    private let token = "SYNTHETIC-TOKEN-5821"

    /// A fresh preferences domain for one test, removed afterwards.
    private func withDefaults(_ body: (UserDefaults, String) throws -> Void) rethrows {
        let suite = "natsumi-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        try body(defaults, suite)
    }

    @Test("ログインしたセッションは秘密の保存先に入り、設定の保存先には書かれない")
    func tokenStaysInSecrets() throws {
        try withDefaults { defaults, suite in
            let secrets = MemorySecretStore()
            let store = AccountStore(secrets: secrets, defaults: defaults)
            store.serverAddress = try ServerAddress("https://natsumi.example.net")
            store.deviceId = "device-1"
            try store.saveSession(SessionGrant(token: token, expiresAt: Date(timeIntervalSince1970: 2_000_000_000)))

            #expect(secrets.items.values.contains { String(decoding: $0, as: UTF8.self).contains(token) })
            let written = defaults.persistentDomain(forName: suite) ?? [:]
            #expect(Set(written.keys) == Set(AccountStore.preferenceKeys))
            #expect(written.values.allSatisfy { "\($0)".contains(token) == false })
        }
    }

    @Test("期限の前はセッションを返し、期限を過ぎたら消して nil を返す")
    func expiry() throws {
        try withDefaults { defaults, _ in
            let secrets = MemorySecretStore()
            let store = AccountStore(secrets: secrets, defaults: defaults)
            try store.saveSession(SessionGrant(token: token, expiresAt: Date(timeIntervalSince1970: 1_000)))
            #expect(store.session(at: Date(timeIntervalSince1970: 999))?.token == token)
            #expect(store.session(at: Date(timeIntervalSince1970: 1_000)) == nil)
            #expect(secrets.items.isEmpty)
        }
    }

    @Test("ログアウトでセッションを消す")
    func clear() throws {
        try withDefaults { defaults, _ in
            let secrets = MemorySecretStore()
            let store = AccountStore(secrets: secrets, defaults: defaults)
            try store.saveSession(SessionGrant(token: token, expiresAt: Date(timeIntervalSince1970: 2_000_000_000)))
            store.clearSession()
            #expect(secrets.items.isEmpty)
            #expect(store.session(at: Date(timeIntervalSince1970: 0)) == nil)
        }
    }

    @Test("接続先を変えると、前のサーバーのセッションと端末 ID を捨てる")
    func changingServer() throws {
        try withDefaults { defaults, _ in
            let secrets = MemorySecretStore()
            let store = AccountStore(secrets: secrets, defaults: defaults)
            store.serverAddress = try ServerAddress("https://natsumi.example.net")
            store.deviceId = "device-1"
            try store.saveSession(SessionGrant(token: token, expiresAt: Date(timeIntervalSince1970: 2_000_000_000)))

            store.serverAddress = try ServerAddress("https://natsumi.example.net")
            #expect(store.deviceId == "device-1")

            store.serverAddress = try ServerAddress("https://other.example.net")
            #expect(store.deviceId == nil)
            #expect(secrets.items.isEmpty)
        }
    }

    @Test("接続先と端末 ID は、設定の保存先から読み直せる")
    func preferencesPersist() throws {
        try withDefaults { defaults, _ in
            let store = AccountStore(secrets: MemorySecretStore(), defaults: defaults)
            store.serverAddress = try ServerAddress("https://natsumi.example.net:8443")
            store.deviceId = "device-1"
            let reopened = AccountStore(secrets: MemorySecretStore(), defaults: defaults)
            #expect(reopened.serverAddress?.origin.absoluteString == "https://natsumi.example.net:8443")
            #expect(reopened.deviceId == "device-1")
        }
    }

    @Test("Keychain に書いて読み、消せる")
    func keychainRoundTrip() throws {
        let keychain = KeychainSecretStore(service: "io.github.yuanying.natsumi.tests.\(UUID().uuidString)")
        defer { try? keychain.delete(account: "session") }
        #expect(try keychain.read(account: "session") == nil)
        try keychain.write(Data("first".utf8), account: "session")
        try keychain.write(Data("second".utf8), account: "session")
        #expect(try keychain.read(account: "session") == Data("second".utf8))
        try keychain.delete(account: "session")
        #expect(try keychain.read(account: "session") == nil)
    }
}

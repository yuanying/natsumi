import Foundation
import Testing
@testable import NatsumiCore

@Suite("接続先のサーバーの URL")
struct ServerAddressTests {
    @Test("https の origin から、WSS の URL と API の URL を作る")
    func https() throws {
        let address = try ServerAddress("https://natsumi.example.net")
        #expect(address.origin.absoluteString == "https://natsumi.example.net")
        #expect(address.webSocketURL.absoluteString == "wss://natsumi.example.net/v1/ws")
        #expect(address.url(path: "/auth/session").absoluteString == "https://natsumi.example.net/auth/session")
    }

    @Test("ポートを保ち、前後の空白と末尾の / を取り除く")
    func portAndSlash() throws {
        let address = try ServerAddress("  https://natsumi.example.net:8443/ \n")
        #expect(address.origin.absoluteString == "https://natsumi.example.net:8443")
        #expect(address.webSocketURL.absoluteString == "wss://natsumi.example.net:8443/v1/ws")
    }

    @Test("http は loopback のホストに限る")
    func loopbackHTTP() throws {
        #expect(try ServerAddress("http://localhost:8080").webSocketURL.absoluteString == "ws://localhost:8080/v1/ws")
        #expect(try ServerAddress("http://127.0.0.1:8080").origin.absoluteString == "http://127.0.0.1:8080")
        #expect(throws: ServerAddressError.insecure) { try ServerAddress("http://natsumi.example.net") }
    }

    @Test("origin 以外の部分や、https 以外の scheme は受け付けない")
    func rejects() {
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("natsumi.example.net") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("ftp://natsumi.example.net") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("https://natsumi.example.net/app") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("https://natsumi.example.net?x=1") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress("https://user@natsumi.example.net") }
    }
}

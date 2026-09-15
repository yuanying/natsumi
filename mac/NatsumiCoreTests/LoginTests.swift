import Foundation
import Testing
@testable import NatsumiCore

@Suite("ログイン: PKCE と state")
struct PKCETests {
    @Test("challenge は verifier の SHA-256 を base64url にしたもの（RFC 7636 の例）")
    func rfcExample() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test("生成した verifier と state は、43〜128 文字の URL で安全な文字で、毎回違う")
    func generated() {
        let first = LoginAttempt()
        let second = LoginAttempt()
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        for value in [first.pkce.verifier, first.state] {
            #expect((43...128).contains(value.count))
            #expect(value.unicodeScalars.allSatisfy { allowed.contains($0) })
        }
        #expect(first.pkce.verifier != second.pkce.verifier)
        #expect(first.state != second.state)
        #expect(first.state != first.pkce.verifier)
    }

    @Test("開始の URL は challenge・S256・state を付けた /auth/github/start")
    func startURL() throws {
        let attempt = LoginAttempt(pkce: PKCE(verifier: String(repeating: "a", count: 43)), state: "state-example-state-example-state-example-00")
        let url = attempt.startURL(server: try ServerAddress("https://natsumi.example.net:8443"))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "https")
        #expect(components.host == "natsumi.example.net")
        #expect(components.port == 8443)
        #expect(components.path == "/auth/github/start")
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == [
            "code_challenge": attempt.pkce.challenge,
            "code_challenge_method": "S256",
            "state": "state-example-state-example-state-example-00",
        ])
    }
}

@Suite("ログイン: callback の URL")
struct CallbackTests {
    private let attempt = LoginAttempt(pkce: PKCE(verifier: String(repeating: "v", count: 43)), state: "expected-state")

    @Test("state が一致すれば login code を取り出す")
    func code() throws {
        #expect(try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?code=login-code&state=expected-state")!) == "login-code")
    }

    @Test("state がない・一致しないなら、code や error があっても受け付けない")
    func stateMismatch() {
        #expect(throws: LoginError.stateMismatch) { try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?code=c&state=other")!) }
        #expect(throws: LoginError.stateMismatch) { try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?code=c")!) }
        #expect(throws: LoginError.stateMismatch) { try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?error=github-denied&state=other")!) }
    }

    @Test("サーバーのエラーコードを返す")
    func serverError() {
        #expect(throws: LoginError.server("account-not-allowed")) {
            try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?error=account-not-allowed&state=expected-state")!)
        }
    }

    @Test("code も error もなければ失敗とする")
    func missingCode() {
        #expect(throws: LoginError.missingCode) { try attempt.loginCode(from: URL(string: "natsumi://oauth/callback?state=expected-state")!) }
    }

    @Test("natsumi://oauth/callback 以外の URL は受け付けない")
    func notCallback() {
        #expect(throws: LoginError.notCallback) { try attempt.loginCode(from: URL(string: "https://oauth/callback?code=c&state=expected-state")!) }
        #expect(throws: LoginError.notCallback) { try attempt.loginCode(from: URL(string: "natsumi://oauth/other?code=c&state=expected-state")!) }
        #expect(throws: LoginError.notCallback) { try attempt.loginCode(from: URL(string: "natsumi://evil/callback?code=c&state=expected-state")!) }
    }
}

@Suite("ログイン: セッションの交換とログアウト")
struct SessionAPITests {
    private let server = try! ServerAddress("https://natsumi.example.net")

    @Test("POST /auth/session に JSON で code と codeVerifier を送る")
    func sessionRequest() throws {
        let request = AuthAPI.sessionRequest(server: server, loginCode: "login-code", verifier: "verifier-example")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://natsumi.example.net/auth/session")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(body == ["code": "login-code", "codeVerifier": "verifier-example"])
    }

    @Test("200 の token と expiresAt をセッションにする")
    func grant() throws {
        let data = Fixture.json(["token": "token-example", "expiresAt": "2026-01-01T12:00:00.000Z"])
        let grant = try AuthAPI.session(status: 200, body: data)
        #expect(grant.token == "token-example")
        #expect(grant.expiresAt == Date(timeIntervalSince1970: 1_767_268_800))
    }

    @Test("エラー応答は HTTP の状態とエラーコードにする")
    func failure() {
        #expect(throws: LoginError.http(status: 400, code: "invalid-grant")) {
            try AuthAPI.session(status: 400, body: Fixture.json(["error": "invalid-grant"]))
        }
        #expect(throws: LoginError.http(status: 502, code: nil)) { try AuthAPI.session(status: 502, body: Data("<html>".utf8)) }
        #expect(throws: LoginError.invalidResponse) { try AuthAPI.session(status: 200, body: Fixture.json(["token": "t"])) }
    }

    @Test("セッションは期限の時刻から期限切れになる")
    func expiry() {
        let grant = SessionGrant(token: "t", expiresAt: Date(timeIntervalSince1970: 100))
        #expect(grant.isExpired(at: Date(timeIntervalSince1970: 99)) == false)
        #expect(grant.isExpired(at: Date(timeIntervalSince1970: 100)))
    }

    @Test("ログアウトと WSS の接続には Bearer を付ける")
    func bearer() {
        let logout = AuthAPI.logoutRequest(server: server, token: "token-example")
        #expect(logout.httpMethod == "POST")
        #expect(logout.url?.absoluteString == "https://natsumi.example.net/auth/logout")
        #expect(logout.value(forHTTPHeaderField: "Authorization") == "Bearer token-example")

        let socket = AuthAPI.webSocketRequest(server: server, token: "token-example")
        #expect(socket.url?.absoluteString == "wss://natsumi.example.net/v1/ws")
        #expect(socket.value(forHTTPHeaderField: "Authorization") == "Bearer token-example")
        #expect(socket.value(forHTTPHeaderField: "Origin") == nil)
    }
}

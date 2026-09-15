import CryptoKit
import Foundation
import Security

public enum LoginError: Error, Equatable {
    /// The URL is not `natsumi://oauth/callback`.
    case notCallback
    /// The callback's state is missing or not the one this attempt generated.
    case stateMismatch
    case missingCode
    /// The server's error code from the callback.
    case server(String)
    case http(status: Int, code: String?)
    case invalidResponse
    case cancelled
}

/// A PKCE verifier and its S256 challenge (RFC 7636).
public struct PKCE: Equatable, Sendable {
    public let verifier: String
    public let challenge: String

    public init(verifier: String) {
        self.verifier = verifier
        challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func random() -> PKCE {
        PKCE(verifier: randomToken())
    }
}

/// One login: the app's own PKCE and state for `/auth/github/start` and the callback.
public struct LoginAttempt: Equatable, Sendable {
    public static let callbackScheme = "natsumi"

    public let pkce: PKCE
    public let state: String

    public init(pkce: PKCE = .random(), state: String = randomToken()) {
        self.pkce = pkce
        self.state = state
    }

    public func startURL(server: ServerAddress) -> URL {
        var components = URLComponents(url: server.url(path: "/auth/github/start"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        return components.url!
    }

    /// The login code from `natsumi://oauth/callback`, after checking the state is this attempt's.
    public func loginCode(from url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == Self.callbackScheme, components.host == "oauth", components.path == "/callback"
        else { throw LoginError.notCallback }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw LoginError.stateMismatch }
        if let error = value("error") { throw LoginError.server(error) }
        guard let code = value("code"), !code.isEmpty else { throw LoginError.missingCode }
        return code
    }
}

/// A session token from `POST /auth/session`.
public struct SessionGrant: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Date

    public init(token: String, expiresAt: Date) {
        self.token = token
        self.expiresAt = expiresAt
    }

    public func isExpired(at now: Date) -> Bool { now >= expiresAt }
}

/// Requests and responses of the login and session routes.
public enum AuthAPI {
    public static func sessionRequest(server: ServerAddress, loginCode: String, verifier: String) -> URLRequest {
        var request = URLRequest(url: server.url(path: "/auth/session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": loginCode, "codeVerifier": verifier])
        return request
    }

    public static func session(status: Int, body: Data) throws -> SessionGrant {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        guard status == 200 else { throw LoginError.http(status: status, code: object?["error"] as? String) }
        guard let token = object?["token"] as? String, !token.isEmpty,
              let text = object?["expiresAt"] as? String, let expiresAt = parseTimestamp(text)
        else { throw LoginError.invalidResponse }
        return SessionGrant(token: token, expiresAt: expiresAt)
    }

    public static func logoutRequest(server: ServerAddress, token: String) -> URLRequest {
        var request = URLRequest(url: server.url(path: "/auth/logout"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// The WebSocket upgrade. Native clients send no Origin.
    public static func webSocketRequest(server: ServerAddress, token: String) -> URLRequest {
        var request = URLRequest(url: server.webSocketURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

func parseTimestamp(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: text)
}

/// 256 random bits as base64url: 43 characters, valid as both a PKCE verifier and a state.
public func randomToken() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    precondition(status == errSecSuccess, "no system randomness")
    return base64URL(Data(bytes))
}

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

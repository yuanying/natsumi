import Foundation

public enum ServerAddressError: Error, Equatable {
    /// Not an origin (`https://host[:port]`).
    case invalid
    /// Plain http to a host other than loopback.
    case insecure
}

/// The server's public origin, as the owner enters it in settings.
public struct ServerAddress: Equatable, Sendable {
    public let origin: URL

    private static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

    public init(_ text: String) throws {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else { throw ServerAddressError.invalid }
        switch scheme {
        case "https": break
        case "http": guard Self.loopbackHosts.contains(host.lowercased()) else { throw ServerAddressError.insecure }
        default: throw ServerAddressError.invalid
        }
        if trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let origin = URL(string: scheme + trimmed.dropFirst(scheme.count)) else { throw ServerAddressError.invalid }
        self.origin = origin
    }

    /// `wss://` (or `ws://` for loopback http) `…/v1/ws`.
    public var webSocketURL: URL {
        let text = origin.absoluteString
        let secure = text.hasPrefix("https:")
        let rest = text.dropFirst(secure ? "https".count : "http".count)
        return URL(string: (secure ? "wss" : "ws") + rest + "/v1/ws")!
    }

    public func url(path: String) -> URL {
        URL(string: origin.absoluteString + path)!
    }
}

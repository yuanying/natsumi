import AppKit
import AuthenticationServices
import NatsumiCore

/// GitHub login through the server (ADR 0006): the browser sheet opens `/auth/github/start` with the app's PKCE and
/// state, the server redirects to `natsumi://oauth/callback`, and the login code is exchanged for a session.
@MainActor
final class GitHubLoginFlow: NSObject {
    private var session: ASWebAuthenticationSession?

    func run(server: ServerAddress) async throws -> SessionGrant {
        let attempt = LoginAttempt()
        defer { session = nil }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: attempt.startURL(server: server), callback: .customScheme(LoginAttempt.callbackScheme)
            ) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: LoginError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? LoginError.invalidResponse)
                }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { continuation.resume(throwing: LoginError.cancelled) }
        }
        let code = try attempt.loginCode(from: callback)
        let (data, response) = try await URLSession.shared.data(
            for: AuthAPI.sessionRequest(server: server, loginCode: code, verifier: attempt.pkce.verifier))
        return try AuthAPI.session(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }
}

extension GitHubLoginFlow: @preconcurrency ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor()
    }
}

#if os(macOS)
import AppKit
#else
import UIKit
#endif
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
            // The handler is called off the main thread, so it must not be a closure written here (see LoginCompletion).
            let completion = LoginCompletion(continuation)
            let session = ASWebAuthenticationSession(
                url: attempt.startURL(server: server), callback: .customScheme(LoginAttempt.callbackScheme),
                completionHandler: completion.handler)
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { completion.finish(.failure(LoginError.cancelled)) }
        }
        let code = try attempt.loginCode(from: callback)
        let (data, response) = try await URLSession.shared.data(
            for: AuthAPI.sessionRequest(server: server, loginCode: code, verifier: attempt.pkce.verifier))
        return try AuthAPI.session(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }

    /// What the owner is told when the login did not go through.
    static func describe(_ error: Error) -> String {
        switch error {
        case LoginError.server(let code): "ログインできませんでした（\(code)）"
        case LoginError.http(let status, let code): "ログインできませんでした（HTTP \(status)\(code.map { "、\($0)" } ?? "")）"
        case LoginError.stateMismatch: "ログインの応答が一致しませんでした。やり直してください"
        case is LoginError: "ログインできませんでした"
        default: "ログインできませんでした（\(error.localizedDescription)）"
        }
    }
}

extension GitHubLoginFlow: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor()
        #else
        // The owner asked for the login on the screen, so there is a scene to show the sheet over.
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
            ?? ASPresentationAnchor(windowScene: scenes[0])
        #endif
    }
}

import AuthenticationServices
import Foundation
import Testing
@testable import NatsumiCore

/// AuthenticationServices calls the completion handler on its own XPC queue, not the main thread.
/// The handler is made in a main actor context, as the app does, and called from a background queue.
@Suite("ログイン: ブラウザのシートの完了")
@MainActor
struct LoginCompletionTests {
    private let callback = URL(string: "natsumi://oauth/callback?code=c&state=s")!

    private func complete(_ calls: [(URL?, Error?)]) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let handler = LoginCompletion(continuation).handler
            DispatchQueue.global().async {
                for (url, error) in calls { handler(url, error) }
            }
        }
    }

    @Test("main 以外のキューから呼ばれても、callback の URL を返す")
    func url() async throws {
        #expect(try await complete([(callback, nil)]) == callback)
    }

    @Test("ユーザーのキャンセルは LoginError.cancelled にする")
    func cancelled() async {
        await #expect(throws: LoginError.cancelled) {
            try await complete([(nil, ASWebAuthenticationSessionError(.canceledLogin))])
        }
    }

    @Test("ほかのエラーはそのまま返す")
    func otherError() async {
        let error = await #expect(throws: ASWebAuthenticationSessionError.self) {
            try await complete([(nil, ASWebAuthenticationSessionError(.presentationContextInvalid))])
        }
        #expect(error?.code == .presentationContextInvalid)
    }

    @Test("URL もエラーもなければ LoginError.invalidResponse にする")
    func nothing() async {
        await #expect(throws: LoginError.invalidResponse) { try await complete([(nil, nil)]) }
    }

    @Test("2 回目以降の呼び出しは無視する")
    func once() async throws {
        #expect(try await complete([(callback, nil), (nil, ASWebAuthenticationSessionError(.canceledLogin))]) == callback)
    }

    @Test("start に失敗したときの finish も 1 回だけ効く")
    func finishOnce() async {
        await #expect(throws: LoginError.cancelled) {
            let _: URL = try await withCheckedThrowingContinuation { continuation in
                let completion = LoginCompletion(continuation)
                completion.finish(.failure(LoginError.cancelled))
                let handler = completion.handler
                DispatchQueue.global().async { handler(self.callback, nil) }
            }
        }
    }
}

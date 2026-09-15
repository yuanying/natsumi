import AuthenticationServices
import Foundation
import Synchronization

/// Finishes one browser sheet exactly once.
///
/// AuthenticationServices calls the completion handler on its own queue, not the main thread. A closure written in a
/// main actor context would inherit that isolation, and Swift traps when it is called off the main queue. So the
/// handler is made here, outside any actor, and only resumes the continuation.
public final class LoginCompletion: Sendable {
    private let continuation: Mutex<CheckedContinuation<URL, Error>?>

    public init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = Mutex(continuation)
    }

    /// The completion handler for `ASWebAuthenticationSession`. It may be called on any queue.
    public var handler: @Sendable (URL?, Error?) -> Void {
        { url, error in self.finish(Self.result(url: url, error: error)) }
    }

    /// Resumes with the first result. Later calls are ignored.
    public func finish(_ result: Result<URL, Error>) {
        continuation.withLock { continuation in
            defer { continuation = nil }
            return continuation
        }?.resume(with: result)
    }

    static func result(url: URL?, error: Error?) -> Result<URL, Error> {
        if let url { return .success(url) }
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
            return .failure(LoginError.cancelled)
        }
        return .failure(error ?? LoginError.invalidResponse)
    }
}

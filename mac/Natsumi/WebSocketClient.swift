import Foundation
import NatsumiCore

/// One WebSocket connection. Events are delivered on the main queue in the order they happened.
final class WebSocketClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Event: Sendable {
        case opened
        case message(Data)
        case closed(CloseReason)
    }

    /// A snapshot carries up to 500 messages, far above URLSession's default of 1 MiB.
    private static let maximumMessageSize = 16 * 1024 * 1024

    private let onEvent: @MainActor @Sendable (Event) -> Void
    private let lock = NSLock()
    private var finished = false
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?

    init(request: URLRequest, onEvent: @escaping @MainActor @Sendable (Event) -> Void) {
        self.onEvent = onEvent
        super.init()
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = Self.maximumMessageSize
        self.session = session
        self.task = task
        task.resume()
        receive()
    }

    func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    /// Closes without reporting anything more.
    func close() {
        lock.withLock { finished = true }
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self, case .success(let message) = result else { return }
            switch message {
            case .string(let text): self.emit(.message(Data(text.utf8)))
            case .data(let data): self.emit(.message(data))
            @unknown default: break
            }
            self.receive()
        }
    }

    private func emit(_ event: Event) {
        guard !lock.withLock({ finished }) else { return }
        let handler = onEvent
        DispatchQueue.main.async { MainActor.assumeIsolated { handler(event) } }
    }

    private func finish(_ reason: CloseReason) {
        let first = lock.withLock { () -> Bool in
            defer { finished = true }
            return !finished
        }
        guard first else { return }
        let handler = onEvent
        DispatchQueue.main.async { MainActor.assumeIsolated { handler(.closed(reason)) } }
        session?.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        emit(.opened)
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        finish(closeCode == .invalid ? .network : .code(closeCode.rawValue))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let response = task.response as? HTTPURLResponse, response.statusCode != 101 {
            finish(.httpStatus(response.statusCode))
            return
        }
        let code = (task as? URLSessionWebSocketTask)?.closeCode ?? .invalid
        finish(code == .invalid ? .network : .code(code.rawValue))
    }
}

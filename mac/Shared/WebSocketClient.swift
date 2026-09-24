import Foundation
import NatsumiCore

/// One WebSocket connection. Events are delivered on the main queue in the order they happened.
///
/// While open it pings the server now and then (`Liveness`). A socket whose ping fails or goes unanswered is closed
/// and reported as a network failure, so the usual reconnect picks it up.
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
    /// Touched on the main queue only.
    private var liveness: Liveness?

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
        stopLiveness()
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
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if case .opened = event { self.startLiveness() }
                handler(event)
            }
        }
    }

    @MainActor
    private func startLiveness() {
        guard liveness == nil, !lock.withLock({ finished }) else { return }
        let liveness = Liveness(
            schedule: { delay, action in
                let item = DispatchWorkItem { MainActor.assumeIsolated { action() } }
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
                return WorkItemTimer(item: item)
            },
            ping: { [weak self] answered in
                guard let task = self?.task else { return answered(false) }
                task.sendPing { error in
                    DispatchQueue.main.async { MainActor.assumeIsolated { answered(error == nil) } }
                }
            },
            onDead: { [weak self] in self?.declareDead() })
        self.liveness = liveness
        liveness.start()
    }

    private func stopLiveness() {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.liveness?.stop()
                self.liveness = nil
            }
        }
    }

    /// The ping found the socket dead: it is reported as a network failure and let go.
    private func declareDead() {
        finish(.network)
        task?.cancel()
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
        stopLiveness()
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

private final class WorkItemTimer: LivenessTimer {
    private let item: DispatchWorkItem

    init(item: DispatchWorkItem) { self.item = item }

    func cancel() { item.cancel() }
}

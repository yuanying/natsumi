import Foundation

/// A timer `Liveness` asked for. Once cancelled, it never fires.
public protocol LivenessTimer: AnyObject {
    func cancel()
}

/// Checks that an open socket is still alive by pinging it now and then.
///
/// A socket can die without a close ever arriving — the Mac slept, the Wi-Fi changed, a proxy dropped an idle
/// connection — and the app would then wait forever on it. This pings at an interval and calls the socket dead when
/// a ping fails or its answer does not come in time. The pinging also keeps the socket from looking idle to a proxy
/// that closes quiet connections. The timers and the ping are handed in, so it runs without a socket or a clock.
@MainActor
public final class Liveness {
    public struct Timing: Equatable, Sendable {
        /// How long after an answer the next ping goes out.
        public var interval: TimeInterval
        /// How long a ping may wait for its answer.
        public var timeout: TimeInterval

        public init(interval: TimeInterval, timeout: TimeInterval) {
            self.interval = interval
            self.timeout = timeout
        }

        /// Well inside the 60 seconds after which a reverse proxy commonly closes a socket with no traffic.
        public static let standard = Timing(interval: 20, timeout: 10)
    }

    public typealias Schedule = @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> any LivenessTimer
    /// Sends a ping and reports on the main actor whether its answer came back.
    public typealias Ping = @MainActor (@escaping @MainActor (Bool) -> Void) -> Void

    private let timing: Timing
    private let schedule: Schedule
    private let ping: Ping
    private let onDead: @MainActor () -> Void
    private var timer: (any LivenessTimer)?
    /// Which ping is the current one; answers to any other are late and dropped.
    private var round = 0
    private var isRunning = false

    public init(timing: Timing = .standard, schedule: @escaping Schedule, ping: @escaping Ping,
                onDead: @escaping @MainActor () -> Void) {
        self.timing = timing
        self.schedule = schedule
        self.ping = ping
        self.onDead = onDead
    }

    public func start() {
        guard !isRunning else { return }
        isRunning = true
        waitForNextPing()
    }

    /// Stops for good: nothing is reported after this.
    public func stop() {
        isRunning = false
        round += 1
        timer?.cancel()
        timer = nil
    }

    private func waitForNextPing() {
        timer = schedule(timing.interval) { [weak self] in self?.sendPing() }
    }

    private func sendPing() {
        guard isRunning else { return }
        round += 1
        let current = round
        timer = schedule(timing.timeout) { [weak self] in
            guard let self, self.round == current else { return }
            self.die()
        }
        ping { [weak self] answered in
            guard let self, self.isRunning, self.round == current else { return }
            self.timer?.cancel()
            if answered { self.waitForNextPing() } else { self.die() }
        }
    }

    private func die() {
        stop()
        onDead()
    }
}

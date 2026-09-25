import Foundation
import Testing
@testable import NatsumiCore

/// Timers that fire only when the test says so.
@MainActor
private final class FakeClock {
    final class Timer: LivenessTimer {
        let delay: TimeInterval
        let action: @MainActor () -> Void
        private(set) var isCancelled = false

        init(delay: TimeInterval, action: @escaping @MainActor () -> Void) {
            self.delay = delay
            self.action = action
        }

        func cancel() { isCancelled = true }
    }

    private(set) var timers: [Timer] = []

    var pending: [Timer] { timers.filter { !$0.isCancelled } }

    func schedule(_ delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> any LivenessTimer {
        let timer = Timer(delay: delay, action: action)
        timers.append(timer)
        return timer
    }

    /// Fires the one timer that is waiting, as time would.
    func fire() {
        let timer = pending[0]
        timer.cancel()
        timer.action()
    }
}

@MainActor
@Suite("接続の生存確認（ping）")
struct LivenessTests {
    private let timing = Liveness.Timing(interval: 20, timeout: 10)
    private let clock = FakeClock()
    private let pings = Pings()
    private let deaths = Deaths()

    @MainActor final class Pings {
        var answers: [@MainActor (Bool) -> Void] = []
    }

    @MainActor final class Deaths {
        var count = 0
    }

    private func liveness() -> Liveness {
        let clock = clock, pings = pings, deaths = deaths
        return Liveness(
            timing: timing,
            schedule: { clock.schedule($0, $1) },
            ping: { pings.answers.append($0) },
            onDead: { deaths.count += 1 })
    }

    @Test("始めると間隔を置いてから ping を送り、応答の待ち時間を測る")
    func pingsAfterTheInterval() {
        let l = liveness()
        l.start()
        #expect(clock.pending.map(\.delay) == [20])
        #expect(pings.answers.isEmpty)

        clock.fire()
        #expect(pings.answers.count == 1)
        #expect(clock.pending.map(\.delay) == [10])
    }

    @Test("応答があれば待ち時間を取り消し、また間隔を置いて ping を送る")
    func pongSchedulesTheNext() {
        let l = liveness()
        l.start()
        clock.fire()
        pings.answers[0](true)
        #expect(clock.pending.map(\.delay) == [20])
        clock.fire()
        #expect(pings.answers.count == 2)
        #expect(deaths.count == 0)
    }

    @Test("ping が失敗したら、死んだ接続として一度だけ知らせる")
    func failedPingIsDeath() {
        let l = liveness()
        l.start()
        clock.fire()
        pings.answers[0](false)
        #expect(deaths.count == 1)
        #expect(clock.pending.isEmpty)
    }

    @Test("待ち時間のうちに応答が無ければ死んだ接続とし、遅れた応答は使わない")
    func noAnswerIsDeath() {
        let l = liveness()
        l.start()
        clock.fire()
        clock.fire()
        #expect(deaths.count == 1)
        pings.answers[0](true)
        #expect(deaths.count == 1)
        #expect(clock.pending.isEmpty)
    }

    @Test("止めたら、待っているタイマーを取り消し、その後の応答や失敗では何も知らせない")
    func stopSilences() {
        let l = liveness()
        l.start()
        clock.fire()
        l.stop()
        #expect(clock.pending.isEmpty)
        pings.answers[0](false)
        #expect(deaths.count == 0)
        #expect(clock.pending.isEmpty)
    }

    @Test("標準の間隔は、Ingress の読み取りのタイムアウト（60 秒）より短い")
    func standardTimingKeepsTheSocketBusy() {
        #expect(Liveness.Timing.standard.interval < 60)
        #expect(Liveness.Timing.standard.timeout < Liveness.Timing.standard.interval)
    }

    @MainActor final class Session {
        var machine = SessionMachine(deviceId: nil, makeRequestId: { "r1" })
        var effects: [SessionEffect] = []
    }

    @Test("生存確認で死んだ接続は、network の close として既存の再接続に乗る")
    func deathLeadsToReconnect() {
        let session = Session()
        _ = session.machine.start()
        _ = session.machine.connected()
        _ = session.machine.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))

        let clock = clock, pings = pings
        let l = Liveness(
            timing: timing, schedule: { clock.schedule($0, $1) }, ping: { pings.answers.append($0) },
            onDead: { session.effects = session.machine.closed(.network) })
        l.start()
        clock.fire()
        clock.fire()
        #expect(session.effects == [.scheduleReconnect(after: 1)])
        #expect(session.machine.phase == .waitingToReconnect)
    }
}

import Foundation
import Testing
@testable import NatsumiCore

@Suite("接続・同期・送信・再接続の流れ")
struct SessionMachineTests {
    /// A machine whose request IDs are r1, r2, ...
    private func machine(deviceId: String? = nil) -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: deviceId) {
            counter += 1
            return "r\(counter)"
        }
    }

    private func sent(_ effects: [SessionEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }
    }

    /// Connects and receives a snapshot for the first sync.
    private func ready(_ m: inout SessionMachine, seq: Int = 1, messages: [[String: Any]] = []) {
        _ = m.start()
        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(seq: seq, requestId: sync.requestId, deviceId: "device-1", messages: messages))
    }

    @Test("接続したら、保存した端末 ID と resume なしで session.sync を送る")
    func firstSync() {
        var m = machine(deviceId: "device-saved")
        #expect(m.start() == [.connect])
        #expect(m.phase == .connecting)
        let effects = m.connected()
        #expect(sent(effects) == [ClientEnvelope(requestId: "r1", deviceId: "device-saved", command: .sessionSync(resume: nil))])
        #expect(m.phase == .syncing)
    }

    @Test("snapshot で使える状態になり、新しい端末 ID を保存する")
    func snapshotMakesReady() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        let effects = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-new",
            messages: [Fixture.message("m1", role: "owner", kind: "message", eventId: "e1")]))
        #expect(effects.contains(.saveDeviceId("device-new")))
        #expect(m.phase == .ready)
        #expect(m.deviceId == "device-new")
        #expect(m.conversation.messages.map(\.messageId) == ["m1"])
    }

    @Test("使える状態での送信は、端末 ID と新しい requestId を付けてすぐ送る")
    func sendWhenReady() {
        var m = machine()
        ready(&m)
        let effects = m.send(text: "架空のメッセージ")
        #expect(sent(effects) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .conversationSend(text: "架空のメッセージ"))])
        #expect(m.conversation.outbox.map(\.status) == [.sending])
    }

    @Test("同期の前の送信は保留し、同期が済んだら同じ requestId で送る")
    func sendBeforeSync() {
        var m = machine()
        _ = m.start()
        #expect(sent(m.send(text: "やあ")).isEmpty)
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.snapshot(seq: 1, requestId: sync.requestId, deviceId: "device-1"))
        #expect(sent(effects) == [ClientEnvelope(requestId: "r1", deviceId: "device-1", command: .conversationSend(text: "やあ"))])
    }

    @Test("受付の前に切れた送信は、再接続の同期の後に同じ requestId で送り直す")
    func resendAfterReconnect() {
        var m = machine()
        ready(&m)
        let first = sent(m.send(text: "やあ"))[0]
        _ = m.closed(.network)
        _ = m.reconnectTimerFired()
        let sync = sent(m.connected())[0]
        // The resume answer takes the next number on the stream the snapshot established.
        let effects = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(sent(effects).map(\.requestId) == [first.requestId])
    }

    @Test("再接続では、最後に受け取った位置から resume を求め、欠けたイベントを適用する")
    func resume() {
        var m = machine()
        ready(&m, seq: 4)
        _ = m.received(Fixture.envelope("avatar.expression", seq: 5, payload: ["expression": "happy"]))
        _ = m.closed(.code(1006))
        _ = m.reconnectTimerFired()
        let sync = sent(m.connected())[0]
        #expect(sync.command == .sessionSync(resume: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 5)))
        #expect(sync.deviceId == "device-1")

        _ = m.received(Fixture.envelope("conversation.message", seq: 6, payload: Fixture.message("m9", replyTo: "e1")))
        _ = m.received(Fixture.envelope("command.accepted", seq: 7, requestId: sync.requestId, payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(m.phase == .ready)
        #expect(m.conversation.messages.map(\.messageId) == ["m9"])
    }

    @Test("seq の欠けでは snapshot を求める session.sync を一度だけ送る")
    func gapAsksForSnapshotOnce() {
        var m = machine()
        ready(&m, seq: 1)
        let first = m.received(Fixture.envelope("avatar.expression", seq: 3, payload: ["expression": "happy"]))
        #expect(sent(first) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .sessionSync(resume: nil))])
        #expect(m.phase == .syncing)
        let second = m.received(Fixture.envelope("avatar.expression", seq: 4, payload: ["expression": "sad"]))
        #expect(sent(second).isEmpty)
        #expect(m.conversation.expression == .neutral)

        _ = m.received(Fixture.snapshot(seq: 5, requestId: "r2", deviceId: "device-1", expression: "sad"))
        #expect(m.phase == .ready)
        #expect(m.conversation.expression == .sad)
    }

    @Test("切断ごとに待ち時間を倍にし、30 秒で頭打ちにする。同期できたら戻す")
    func backoff() {
        var m = machine()
        _ = m.start()
        var delays: [TimeInterval] = []
        for _ in 0..<7 {
            for case .scheduleReconnect(let delay) in m.closed(.network) { delays.append(delay) }
            #expect(m.phase == .waitingToReconnect)
            #expect(m.reconnectTimerFired() == [.connect])
        }
        #expect(delays == [1, 2, 4, 8, 16, 30, 30])

        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(seq: 1, requestId: sync.requestId))
        #expect(m.closed(.code(4002)) == [.scheduleReconnect(after: 1)])
    }

    @Test("セッションの失効（1008 や 401）では再接続せず、ログインを求める")
    func sessionEnded() {
        var m = machine()
        ready(&m)
        #expect(m.closed(.code(1008)) == [.requireLogin])
        #expect(m.phase == .loginRequired)
        #expect(m.reconnectTimerFired().isEmpty)

        var refused = machine()
        _ = refused.start()
        #expect(refused.closed(.httpStatus(401)) == [.requireLogin])
    }

    @Test("同じ端末の新しい接続に置き換えられたら（4001）、再接続しない")
    func replaced() {
        var m = machine()
        ready(&m)
        #expect(m.closed(.code(4001)).isEmpty)
        #expect(m.phase == .replaced)
    }

    @Test("プロトコルの誤り（1002・1007）では再接続しない")
    func protocolError() {
        var m = machine()
        ready(&m)
        #expect(m.closed(.code(1002)).isEmpty)
        #expect(m.phase == .stopped)
    }

    @Test("同期の応答が service.unavailable なら、会話を使えない状態として表示する")
    func unavailable() {
        var m = machine()
        _ = m.start()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.envelope("service.unavailable", seq: 1, requestId: sync.requestId,
            payload: ["code": "conversation-restore-failed", "deviceId": "device-1"]))
        #expect(effects.contains(.saveDeviceId("device-1")))
        #expect(m.phase == .unavailable("conversation-restore-failed"))
    }

    @Test("未知の type と読めないメッセージは無視して、続きのイベントを適用する")
    func ignoresUnknown() {
        var m = machine()
        ready(&m, seq: 1)
        #expect(m.received(Fixture.envelope("notification.batch", seq: 2)).isEmpty)
        #expect(m.received(Data("garbage".utf8)).isEmpty)
        _ = m.received(Fixture.envelope("avatar.expression", seq: 3, payload: ["expression": "laughing"]))
        #expect(m.conversation.expression == .laughing)
        #expect(m.phase == .ready)
    }

    @Test("停止すると、切断を受けても再接続しない")
    func stop() {
        var m = machine()
        ready(&m)
        #expect(m.stop() == [.disconnect])
        #expect(m.closed(.network).isEmpty)
        #expect(m.phase == .idle)
    }
}

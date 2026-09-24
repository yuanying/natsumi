import Foundation
import Testing
@testable import NatsumiCore

/// The Mac woke from sleep: the socket may have died without a word, so the machine drops it and connects again at
/// once, from where the stream was.
@Suite("スリープ復帰でのつなぎ直し")
struct ReconnectNowTests {
    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    private func sent(_ effects: [SessionEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }
    }

    private func ready(_ m: inout SessionMachine, seq: Int = 1, messages: [[String: Any]] = [], unread: Int = 0) {
        _ = m.start()
        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(
            seq: seq, requestId: sync.requestId, deviceId: "device-1", messages: messages, unreadReplyCount: unread))
    }

    @Test("使える状態なら接続を捨ててつなぎ直し、続きから同期して、欠けたイベントを適用する")
    func readyResumes() {
        var m = machine()
        ready(&m, seq: 3)
        #expect(m.reconnectNow() == [.disconnect, .connect])
        #expect(m.phase == .connecting)

        let sync = sent(m.connected())[0]
        #expect(sync.command == .sessionSync(resume: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3)))
        _ = m.received(Fixture.envelope("conversation.message", seq: 4,
            payload: Fixture.message("m1", role: "owner", kind: "message", text: "iPhone から", eventId: "e1")))
        _ = m.received(Fixture.envelope("conversation.message", seq: 5, payload: Fixture.message("m2", replyTo: "e1")))
        _ = m.received(Fixture.envelope("command.accepted", seq: 6, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(m.phase == .ready)
        #expect(m.conversation.messages.map(\.messageId) == ["m1", "m2"])
    }

    @Test("サーバーのバッファから外れていれば、snapshot で置き換える")
    func readyTakesASnapshot() {
        var m = machine()
        ready(&m, seq: 3, messages: [Fixture.message("old")])
        _ = m.reconnectNow()
        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(seq: 1, stream: "stream-new", requestId: sync.requestId, deviceId: "device-1",
            messages: [Fixture.message("old"), Fixture.message("new")]))
        #expect(m.phase == .ready)
        #expect(m.conversation.messages.map(\.messageId) == ["old", "new"])
    }

    @Test("接続中・同期中・会話を使えない状態でも、待たずにつなぎ直す。古い同期の答えは使わない")
    func inTheMiddleOfConnecting() {
        var connecting = machine()
        _ = connecting.start()
        #expect(connecting.reconnectNow() == [.disconnect, .connect])
        #expect(connecting.phase == .connecting)

        var syncing = machine()
        _ = syncing.start()
        let stale = sent(syncing.connected())[0]
        #expect(syncing.reconnectNow() == [.disconnect, .connect])
        #expect(syncing.received(Fixture.snapshot(seq: 1, requestId: stale.requestId, deviceId: "device-1")).isEmpty)
        #expect(syncing.phase == .connecting)

        var unavailable = machine()
        _ = unavailable.start()
        let sync = sent(unavailable.connected())[0]
        _ = unavailable.received(Fixture.envelope("service.unavailable", seq: 1, requestId: sync.requestId,
            payload: ["code": "pi-unavailable", "deviceId": "device-1"]))
        #expect(unavailable.reconnectNow() == [.disconnect, .connect])
        #expect(unavailable.phase == .connecting)
    }

    @Test("再接続を待っている間なら、待たずにつなぎ直す")
    func waitingToReconnect() {
        var m = machine()
        ready(&m)
        _ = m.closed(.network)
        #expect(m.reconnectNow() == [.disconnect, .connect])
        #expect(m.phase == .connecting)
        #expect(m.reconnectTimerFired().isEmpty)
    }

    @Test("止まっている・ログインが要る・置き換えられた・止めた状態では何もしない")
    func nothingToDo() {
        var idle = machine()
        #expect(idle.reconnectNow().isEmpty)
        #expect(idle.phase == .idle)

        var login = machine()
        ready(&login)
        _ = login.closed(.code(1008))
        #expect(login.reconnectNow().isEmpty)
        #expect(login.phase == .loginRequired)

        var replaced = machine()
        ready(&replaced)
        _ = replaced.closed(.code(4001))
        #expect(replaced.reconnectNow().isEmpty)
        #expect(replaced.phase == .replaced)

        var stopped = machine()
        ready(&stopped)
        _ = stopped.closed(.code(1002))
        #expect(stopped.reconnectNow().isEmpty)
        #expect(stopped.phase == .stopped)
    }

    @Test("届いたか分からない送信と既読は、つなぎ直した同期の後に同じ requestId で送り直す")
    func resendsWhatWasInFlight() {
        var m = machine()
        ready(&m, seq: 1, messages: [Fixture.message("reply-1")], unread: 1)
        let message = sent(m.send(text: "寝る前に送った"))[0]
        let read = sent(m.readReplies(through: "reply-1"))[0]
        _ = m.reconnectNow()
        // Sent after the drop and before the sync: kept until the sync is done.
        #expect(sent(m.send(text: "起きてすぐ送った")).isEmpty)

        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        let again = sent(effects).map(\.requestId)
        #expect(again.contains(message.requestId))
        #expect(again.contains(read.requestId))
        #expect(m.conversation.outbox.map(\.text) == ["寝る前に送った", "起きてすぐ送った"])
        #expect(sent(effects).filter { if case .conversationSend = $0.command { true } else { false } }.count == 2)
    }
}

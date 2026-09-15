import Foundation
import Testing
@testable import NatsumiCore

@Suite("既読と知らせの確認を送る")
struct ReadCommandTests {
    /// A machine whose request IDs are r1, r2, ...
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

    /// Connects and receives a snapshot of r1 (reply), n2 (notice), r3 (reply), nothing read yet.
    private func ready(_ m: inout SessionMachine, notices: [String] = ["n2"]) {
        _ = m.start()
        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(seq: 1, requestId: sync.requestId, deviceId: "device-1", messages: [
            Fixture.message("r1"), Fixture.message("n2", kind: "notice"), Fixture.message("r3"),
        ], readThrough: nil, unreadReplyCount: 2, unacknowledged: notices))
    }

    @Test("前の返事の確認は、その messageId を throughMessageId にして conversation.read を送り、次の未読を前に出す")
    func confirmFront() {
        var m = machine()
        ready(&m)
        #expect(sent(m.confirmFrontReply()) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .conversationRead(throughMessageId: "r1"))])
        #expect(m.conversation.unreadReplies.map(\.messageId) == ["r3"])
        #expect(sent(m.confirmFrontReply()) == [ClientEnvelope(requestId: "r3", deviceId: "device-1", command: .conversationRead(throughMessageId: "r3"))])
        #expect(m.conversation.unreadReplies.isEmpty)
        #expect(m.confirmFrontReply().isEmpty)
    }

    @Test("× は、未読の最後の返事の messageId で一度だけ送り、全部を確かめたことにする")
    func confirmAll() {
        var m = machine()
        ready(&m)
        #expect(sent(m.confirmAllReplies()) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .conversationRead(throughMessageId: "r3"))])
        #expect(m.conversation.unreadReplies.isEmpty)
        #expect(m.conversation.unreadReplyCount == 0)
        #expect(m.confirmAllReplies().isEmpty)
        // Reading replies does not check the notice between them.
        #expect(m.conversation.unacknowledgedNotificationIds == ["n2"])
    }

    @Test("知らせの確認は、notificationId にその messageId を入れて notification.ack を送る。確認済みは送らない")
    func acknowledge() {
        var m = machine()
        ready(&m)
        #expect(sent(m.acknowledge(["n2"])) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .notificationAck(notificationId: "n2"))])
        #expect(m.conversation.unacknowledgedNotificationIds.isEmpty)
        #expect(m.acknowledge(["n2"]).isEmpty)
    }

    @Test("一覧の外の古い知らせは、まとめて確かめると 1 件ずつ送る")
    func acknowledgeOlder() {
        var m = machine()
        ready(&m, notices: ["n-a", "n-b", "n2"])
        let envelopes = sent(m.acknowledge(["n-a", "n-b"]))
        #expect(envelopes.map(\.command) == [.notificationAck(notificationId: "n-a"), .notificationAck(notificationId: "n-b")])
        #expect(m.conversation.unacknowledgedNotificationIds == ["n2"])
    }

    @Test("切断中の確認は見た目だけ先に進め、同期が済んだら同じ requestId で送る")
    func whileDisconnected() {
        var m = machine()
        ready(&m)
        _ = m.closed(.network)
        #expect(m.confirmFrontReply().isEmpty)
        #expect(m.acknowledge(["n2"]).isEmpty)
        #expect(m.conversation.unreadReplies.map(\.messageId) == ["r3"])
        #expect(m.conversation.unacknowledgedNotificationIds.isEmpty)

        _ = m.reconnectTimerFired()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(sent(effects) == [
            ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .conversationRead(throughMessageId: "r1")),
            ClientEnvelope(requestId: "r3", deviceId: "device-1", command: .notificationAck(notificationId: "n2")),
        ])
    }

    @Test("拒否された確認は状態を戻し、送り直さない。その後の snapshot で正しい状態になる")
    func rejected() {
        var m = machine()
        ready(&m)
        let read = sent(m.confirmFrontReply())[0]
        _ = m.received(Fixture.envelope("command.rejected", seq: 2, requestId: read.requestId, payload: ["code": "invalid-request"]))
        #expect(m.conversation.unreadReplies.map(\.messageId) == ["r1", "r3"])

        _ = m.closed(.network)
        _ = m.reconnectTimerFired()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.snapshot(seq: 1, stream: "stream-2", requestId: sync.requestId, deviceId: "device-1", messages: [
            Fixture.message("r1"), Fixture.message("n2", kind: "notice"), Fixture.message("r3"),
        ], readThrough: "r1", unreadReplyCount: 1, unacknowledged: []))
        #expect(sent(effects).isEmpty)
        #expect(m.conversation.unreadReplies.map(\.messageId) == ["r3"])
        #expect(m.conversation.unacknowledgedNotificationIds.isEmpty)
    }

    @Test("本人がメッセージを送っても、カーソルは進めない")
    func sendDoesNotRead() {
        var m = machine()
        ready(&m)
        let envelopes = sent(m.send(text: "架空のメッセージ"))
        #expect(envelopes.map(\.command) == [.conversationSend(text: "架空のメッセージ")])
        #expect(m.conversation.unreadReplies.map(\.messageId) == ["r1", "r3"])
    }
}

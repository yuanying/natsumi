import Foundation
import Testing
@testable import NatsumiCore

@Suite("知らせを挟んだやり取り")
struct NoticeFlowTests {
    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    /// Runs one exchange as the server sends it: the owner's message is accepted while natsumi is already thinking,
    /// she sends a notice about it, then replies and finishes. `resetExpression` is whether the server puts the face
    /// back to neutral at the end, which it does only when it set the thinking face itself, not when the model did.
    private func exchange(resetExpression: Bool) -> (SessionMachine, BalloonState) {
        var m = machine()
        var balloon = BalloonState()
        _ = m.start()
        let sync = m.connected().compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }[0]
        _ = m.received(Fixture.snapshot(seq: 1, requestId: sync.requestId, deviceId: "device-1", messages: [
            Fixture.message("m0", role: "owner", kind: "message", eventId: "e0"),
            Fixture.message("m00", replyTo: "e0"),
        ]))
        balloon.update(with: m.conversation)

        _ = m.send(text: "架空のメッセージ")
        balloon.update(with: m.conversation)
        #expect(balloon.content == .receiving)

        var seq = 1
        func receive(_ type: String, requestId: String? = nil, _ payload: [String: Any]) {
            seq += 1
            _ = m.received(Fixture.envelope(type, seq: seq, requestId: requestId, payload: payload))
            balloon.update(with: m.conversation)
        }
        receive("command.accepted", requestId: "r2", ["messageId": "m1", "eventId": "e1", "state": "processing"])
        #expect(balloon.content == .thinking)
        receive("conversation.message", Fixture.message("m1", role: "owner", kind: "message", eventId: "e1"))
        receive("avatar.expression", ["expression": "thinking"])
        // The model sets the face through its tool while it works.
        receive("avatar.expression", ["expression": "thinking"])
        #expect(balloon.content == .thinking)

        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        receive("conversation.message", notice)
        #expect(balloon.content == .thinking)

        receive("conversation.message", Fixture.message("m2", text: "架空の返事", replyTo: "e1"))
        receive("conversation.event.completed", ["eventId": "e1", "messageId": "m1", "status": "replied"])
        if resetExpression { receive("avatar.expression", ["expression": "neutral"]) }
        return (m, balloon)
    }

    @Test("知らせと返事が履歴に並び、処理待ちが残らない")
    func conversationAfterNotice() {
        let (m, _) = exchange(resetExpression: false)
        #expect(m.phase == .ready)
        #expect(m.conversation.messages.map(\.messageId) == ["m0", "m00", "m1", "n1", "m2"])
        #expect(m.conversation.messages[3].about == ["e1"])
        #expect(m.conversation.pendingEvents.isEmpty)
        #expect(m.conversation.outbox.isEmpty)
    }

    @Test("返事が済めば、表情が thinking のまま残っていても吹き出しは考え中から返事に変わる")
    func balloonShowsReplyWhileFaceStaysThinking() {
        let (m, balloon) = exchange(resetExpression: false)
        #expect(m.conversation.expression == .thinking)
        #expect(m.conversation.isThinking == false)
        #expect(balloon.content == .message(m.conversation.messages[4]))
        #expect(balloon.isNew)
    }

    @Test("サーバーが表情を戻したときも、吹き出しは返事になる")
    func balloonShowsReplyAfterReset() {
        let (m, balloon) = exchange(resetExpression: true)
        #expect(balloon.content == .message(m.conversation.messages[4]))
    }

    @Test("起動し直した snapshot でも、知らせと返事が戻り、吹き出しは返事を新着にせず出す")
    func snapshotAfterRestart() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var m = machine()
        var balloon = BalloonState()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 9, requestId: "r1", deviceId: "device-1", messages: [
            Fixture.message("m1", role: "owner", kind: "message", eventId: "e1"), notice, Fixture.message("m2", replyTo: "e1"),
        ], expression: "thinking"))
        balloon.update(with: m.conversation)
        #expect(m.conversation.messages.map(\.messageId) == ["m1", "n1", "m2"])
        #expect(balloon.content == .message(m.conversation.messages[2]))
        #expect(balloon.isNew == false)
    }
}

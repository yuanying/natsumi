import Foundation
import Testing
@testable import NatsumiCore

@Suite("会話の表示の状態")
struct ConversationStateTests {
    private func owner(_ id: String, event: String, text: String = "やあ") -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: text, createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String, text: String = "こんにちは") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: text, createdAt: "2026-01-01T00:00:01.000Z", replyTo: event)
    }

    @Test("snapshot で履歴・処理待ち・表情を置き換える")
    func snapshotReplaces() {
        var state = ConversationState()
        state.apply(.message(reply("old", to: "e0")))
        state.apply(.snapshot(Snapshot(
            deviceId: "device-1", messages: [owner("m1", event: "e1")],
            pendingEvents: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)], expression: .thinking)))
        #expect(state.messages.map(\.messageId) == ["m1"])
        #expect(state.pendingEvents == ["e1": .processing])
        #expect(state.expression == .thinking)
        #expect(state.isThinking)
    }

    @Test("同じ messageId のメッセージは二重に並べない")
    func messagesAreUnique() {
        var state = ConversationState()
        state.apply(.message(reply("m1", to: "e1")))
        state.apply(.message(reply("m1", to: "e1")))
        #expect(state.messages.count == 1)
    }

    @Test("送信は受付までは受付中として送信欄の外に残る")
    func sendingUntilAccepted() {
        var state = ConversationState()
        state.enqueue(text: "架空のメッセージ", requestId: "r1")
        #expect(state.outbox == [OutgoingMessage(requestId: "r1", text: "架空のメッセージ", status: .sending)])
        #expect(state.unsent.map(\.requestId) == ["r1"])
    }

    @Test("受付で送信を outbox から外し、イベントを処理待ちにする")
    func accepted() {
        var state = ConversationState()
        state.enqueue(text: "やあ", requestId: "r1")
        state.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .queued)), requestId: "r1")
        #expect(state.outbox.isEmpty)
        #expect(state.pendingEvents == ["e1": .queued])
        #expect(state.isThinking)
    }

    @Test("再送への受付で、すでに終わったイベントを処理待ちに戻さない")
    func acceptedAfterCompletion() {
        var state = ConversationState()
        state.enqueue(text: "やあ", requestId: "r1")
        state.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .replied)), requestId: "r1")
        #expect(state.outbox.isEmpty)
        #expect(state.pendingEvents.isEmpty)
    }

    @Test("拒否とサービス停止は、その送信にエラーとして残し、再送しない")
    func rejected() {
        var state = ConversationState()
        state.enqueue(text: "a", requestId: "r1")
        state.enqueue(text: "b", requestId: "r2")
        state.apply(.rejected(code: "invalid-request"), requestId: "r1")
        state.apply(.unavailable(code: "pi-unavailable", deviceId: nil), requestId: "r2")
        #expect(state.outbox.map(\.status) == [.rejected("invalid-request"), .unavailable("pi-unavailable")])
        #expect(state.unsent.isEmpty)
        state.dismiss(requestId: "r1")
        #expect(state.outbox.map(\.requestId) == ["r2"])
    }

    @Test("他の端末から届いた本人のメッセージも処理待ちになり、完了で外れる")
    func ownerMessageFromAnotherDevice() {
        var state = ConversationState()
        state.apply(.message(owner("m1", event: "e1")))
        #expect(state.pendingEvents == ["e1": .queued])
        state.apply(.message(reply("m2", to: "e1")))
        state.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .replied, reason: nil)))
        #expect(state.pendingEvents.isEmpty)
        #expect(state.isThinking == false)
    }

    @Test("表情のイベントで表情を変える。考え中は処理待ちのイベントだけで決め、表情では決めない")
    func expression() {
        var state = ConversationState()
        #expect(state.expression == .neutral)
        state.apply(.expression(.thinking))
        #expect(state.expression == .thinking)
        // The model may leave the thinking face after it has finished; the server only resets a face it set itself.
        #expect(state.isThinking == false)
        state.apply(.message(owner("m1", event: "e1")))
        #expect(state.isThinking)
        state.apply(.expression(.happy))
        #expect(state.expression == .happy)
        #expect(state.isThinking)
    }

    @Test("返事と知らせを区別できる")
    func replyOrNotice() {
        let notice = ShownMessage(messageId: "n1", role: .natsumi, kind: .notice, text: "お知らせ", createdAt: "2026-01-01T00:00:00.000Z")
        #expect(notice.isNotice)
        #expect(reply("m1", to: "e1").isNotice == false)
    }

    @Test("snapshot の後も、受付の前の送信は残る")
    func outboxSurvivesSnapshot() {
        var state = ConversationState()
        state.enqueue(text: "やあ", requestId: "r1")
        state.apply(.snapshot(Snapshot(deviceId: "d", messages: [], pendingEvents: [], expression: .neutral)))
        #expect(state.unsent.map(\.requestId) == ["r1"])
    }
}

import Foundation
import Testing
@testable import NatsumiCore

@Suite("吹き出しの中身")
struct BalloonStateTests {
    private func owner(_ id: String, event: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String, text: String = "こんにちは") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: text, createdAt: "2026-01-01T00:00:01.000Z", replyTo: event)
    }

    private func notice(_ id: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: "架空のお知らせ", createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func completed(_ event: String, _ message: String) -> ServerEvent {
        .eventCompleted(EventCompletion(eventId: event, messageId: message, status: .replied, reason: nil))
    }

    @Test("何も話していなければ出さない")
    func hiddenWhenEmpty() {
        var balloon = BalloonState()
        balloon.update(with: ConversationState())
        #expect(balloon.content == nil)
    }

    @Test("ナツミの最後の発言（返事か知らせ）を出し、本人のメッセージは出さない")
    func lastNatsumiMessage() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.message(owner("m1", event: "e1")))
        conversation.apply(.message(reply("m2", to: "e1")))
        conversation.apply(completed("e1", "m1"))
        conversation.apply(.message(notice("n1")))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(notice("n1")))

        conversation.apply(.message(owner("m3", event: "e3")))
        conversation.apply(.eventCompleted(EventCompletion(eventId: "e3", messageId: "m3", status: .noReply, reason: nil)))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(notice("n1")))
    }

    @Test("受付の前は受付中、処理待ちや表情が thinking なら考え中を出す")
    func receivingAndThinking() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.message(reply("m0", to: "e0")))
        conversation.enqueue(text: "やあ", requestId: "r1")
        balloon.update(with: conversation)
        #expect(balloon.content == .receiving)

        conversation.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .queued)), requestId: "r1")
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)

        conversation.apply(.message(reply("m2", to: "e1")))
        conversation.apply(completed("e1", "m1"))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(reply("m2", to: "e1")))
    }

    @Test("閉じた発言は出さず、次の発言でまた出す")
    func dismissUntilNextMessage() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.message(reply("m1", to: "e1")))
        balloon.update(with: conversation)
        balloon.dismiss()
        #expect(balloon.content == nil)

        // A send that is refused does not bring the closed message back.
        conversation.enqueue(text: "やあ", requestId: "r1")
        balloon.update(with: conversation)
        #expect(balloon.content == .receiving)
        conversation.apply(.rejected(code: "invalid-request"), requestId: "r1")
        balloon.update(with: conversation)
        #expect(balloon.content == nil)

        conversation.apply(.message(notice("n2")))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(notice("n2")))
    }

    @Test("閉じた考え中は、中身が変わるまで出さない")
    func dismissThinking() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.expression(.thinking))
        balloon.update(with: conversation)
        balloon.dismiss()
        balloon.update(with: conversation)
        #expect(balloon.content == nil)

        conversation.apply(.message(reply("m1", to: "e1")))
        conversation.apply(.expression(.happy))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(reply("m1", to: "e1")))

        conversation.apply(.expression(.thinking))
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)
    }

    @Test("届いたばかりの発言は新着とし、snapshot で出した発言は新着にしない")
    func snapshotIsNotNew() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.snapshot(Snapshot(
            deviceId: "d", messages: [owner("m1", event: "e1"), reply("m2", to: "e1")], pendingEvents: [], expression: .neutral)))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(reply("m2", to: "e1")))
        #expect(balloon.isNew == false)

        conversation.apply(.message(notice("n3")))
        balloon.update(with: conversation)
        #expect(balloon.isNew)

        // Reconnecting brings the same message back in a snapshot: shown, but no longer new.
        conversation.apply(.snapshot(Snapshot(
            deviceId: "d", messages: [reply("m2", to: "e1"), notice("n3")], pendingEvents: [], expression: .neutral)))
        balloon.update(with: conversation)
        #expect(balloon.content == .message(notice("n3")))
        #expect(balloon.isNew == false)
    }

    @Test("snapshot でも、閉じた発言はまた出さない")
    func dismissedSurvivesSnapshot() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(.message(reply("m1", to: "e1")))
        balloon.update(with: conversation)
        balloon.dismiss()
        conversation.apply(.snapshot(Snapshot(deviceId: "d", messages: [reply("m1", to: "e1")], pendingEvents: [], expression: .neutral)))
        balloon.update(with: conversation)
        #expect(balloon.content == nil)
    }

    @Test("長い発言は文字数と行数で切り、続きがあることを示す")
    func preview() {
        #expect(BalloonText.preview("  こんにちは\n") == BalloonText(text: "こんにちは", isTruncated: false))

        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let cut = BalloonText.preview(long)
        #expect(cut.isTruncated)
        #expect(cut.text == String(repeating: "あ", count: BalloonText.maxCharacters) + "…")

        let lines = (1...(BalloonText.maxLines + 2)).map { "行\($0)" }.joined(separator: "\n")
        let cutLines = BalloonText.preview(lines)
        #expect(cutLines.isTruncated)
        #expect(cutLines.text == (1...BalloonText.maxLines).map { "行\($0)" }.joined(separator: "\n") + "…")
    }
}

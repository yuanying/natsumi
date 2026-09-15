import Foundation
import Testing
@testable import NatsumiCore

@Suite("吹き出しの中身")
struct BalloonStateTests {
    private func owner(_ id: String, event: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String = "e0") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: "こんにちは", createdAt: "2026-01-01T00:00:01.000Z", replyTo: event)
    }

    private func notice(_ id: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: "架空のお知らせ", createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func snapshot(
        _ messages: [ShownMessage], readThrough: String?, unread: Int, pending: [PendingEvent] = []
    ) -> ServerEvent {
        .snapshot(Snapshot(
            deviceId: "d", messages: messages, pendingEvents: pending, expression: .neutral,
            readState: ReadState(readThroughMessageId: readThrough, unreadReplyCount: unread, unacknowledgedNotificationIds: [])))
    }

    @Test("何も話していなければ出さない")
    func hiddenWhenEmpty() {
        var balloon = BalloonState()
        balloon.update(with: ConversationState())
        #expect(balloon.content == nil)
        #expect(balloon.isBusy == false)
    }

    @Test("未読の返事を古い順に前へ出し、件数を持つ。本人のメッセージと知らせは入れない")
    func oldestFirst() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot(
            [reply("r0"), owner("m1", event: "e1"), notice("n2"), reply("r3", to: "e1"), reply("r4"), reply("r5"), reply("r6")],
            readThrough: "r0", unread: 4))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r3", to: "e1"), count: 4)))
    }

    @Test("後ろに重ねる枚数には上限があり、超えた分は件数だけにする")
    func behindLimit() {
        #expect(ReplyStack(front: reply("r1"), count: 1).behind == 0)
        #expect(ReplyStack(front: reply("r1"), count: 2).behind == 1)
        #expect(ReplyStack(front: reply("r1"), count: 3).behind == 2)
        #expect(ReplyStack(front: reply("r1"), count: 9).behind == ReplyStack.maxBehind)
        #expect(ReplyStack(front: reply("r1"), count: 9).more == 8)
    }

    @Test("一覧より古い未読は、件数にだけ入る")
    func olderUnread() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot([reply("r5"), reply("r6")], readThrough: "r0", unread: 5))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r5"), count: 5)))
    }

    @Test("前を確かめると次に古い未読を出し、最後を確かめたら閉じる")
    func confirmOneByOne() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot([reply("r1"), notice("n2"), reply("r3")], readThrough: nil, unread: 2))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r1"), count: 2)))

        conversation.markRead(through: "r1", requestId: "q1")
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r3"), count: 1)))

        conversation.markRead(through: "r3", requestId: "q2")
        balloon.update(with: conversation)
        #expect(balloon.content == nil)

        conversation.apply(.message(reply("r4")))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r4"), count: 1)))
    }

    @Test("返事の未読が無く処理待ちがあるときだけ考え中を出し、未読があれば未読を出して処理中の印を付ける")
    func thinkingOnlyWithoutUnread() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot([reply("r0")], readThrough: "r0", unread: 0))
        conversation.enqueue(text: "やあ", requestId: "q1")
        balloon.update(with: conversation)
        #expect(balloon.content == .receiving)

        conversation.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .processing)), requestId: "q1")
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)

        // A notice is not a reply: the balloon keeps thinking.
        conversation.apply(.message(notice("n1")))
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)

        conversation.apply(.message(reply("r2", to: "e1")))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r2", to: "e1"), count: 1)))
        #expect(balloon.isBusy)

        conversation.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .replied, reason: nil)))
        balloon.update(with: conversation)
        #expect(balloon.isBusy == false)
    }

    @Test("未読があるとき、受付の前の送信も印だけにし、本人が送っても未読は残る")
    func sendingKeepsUnread() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot([reply("r1")], readThrough: nil, unread: 1))
        conversation.enqueue(text: "やあ", requestId: "q1")
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r1"), count: 1)))
        #expect(balloon.isBusy)

        conversation.apply(.accepted(CommandAccepted(messageId: "m2", eventId: "e2", state: .queued)), requestId: "q1")
        conversation.apply(.message(owner("m2", event: "e2")))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r1"), count: 1)))
        #expect(balloon.isBusy)
    }

    @Test("閉じた考え中は、中身が変わるまで出さない")
    func dismissThinking() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot(
            [reply("r0"), owner("m1", event: "e1")], readThrough: "r0", unread: 0,
            pending: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)]))
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)
        balloon.dismiss()
        balloon.update(with: conversation)
        #expect(balloon.content == nil)

        conversation.apply(.message(reply("r1", to: "e1")))
        conversation.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .replied, reason: nil)))
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r1", to: "e1"), count: 1)))
        conversation.markRead(through: "r1", requestId: "q1")

        conversation.apply(.message(owner("m2", event: "e2")))
        balloon.update(with: conversation)
        #expect(balloon.content == .thinking)
    }

    @Test("未読の返事は閉じるだけでは消えず、確かめるまで出し続ける")
    func dismissDoesNotReadReplies() {
        var conversation = ConversationState()
        var balloon = BalloonState()
        conversation.apply(snapshot([reply("r1")], readThrough: nil, unread: 1))
        balloon.update(with: conversation)
        balloon.dismiss()
        balloon.update(with: conversation)
        #expect(balloon.content == .replies(ReplyStack(front: reply("r1"), count: 1)))
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

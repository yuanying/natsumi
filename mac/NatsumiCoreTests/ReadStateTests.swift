import Foundation
import Testing
@testable import NatsumiCore

@Suite("既読と知らせの確認の状態")
struct ReadStateTests {
    private func owner(_ id: String, event: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String = "e0") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: "こんにちは", createdAt: "2026-01-01T00:00:01.000Z", replyTo: event)
    }

    private func notice(_ id: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: "架空のお知らせ", createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func snapshot(_ messages: [ShownMessage], readThrough: String?, unread: Int, notices: [String] = []) -> ServerEvent {
        .snapshot(Snapshot(
            deviceId: "d", messages: messages, pendingEvents: [], expression: .neutral,
            readState: ReadState(readThroughMessageId: readThrough, unreadReplyCount: unread, unacknowledgedNotificationIds: notices)))
    }

    @Test("カーソルが一覧の中なら、その後ろの返事だけを未読にし、本人のメッセージと知らせは数えない")
    func cursorInList() {
        var state = ConversationState()
        state.apply(snapshot(
            [reply("r1"), owner("m2", event: "e2"), notice("n3"), reply("r4", to: "e2")], readThrough: "r1", unread: 1, notices: ["n3"]))
        #expect(state.readState.readThroughMessageId == "r1")
        #expect(state.unreadReplies.map(\.messageId) == ["r4"])
        #expect(state.unreadReplyCount == 1)
        #expect(state.unacknowledgedNotificationIds == ["n3"])
    }

    @Test("カーソルが一覧より古ければ、一覧の返事はすべて未読で、件数はサーバーの数を使う")
    func cursorOutsideList() {
        var state = ConversationState()
        state.apply(snapshot([reply("r5"), notice("n6"), reply("r7")], readThrough: "r0", unread: 4, notices: ["n-old", "n6"]))
        #expect(state.unreadReplies.map(\.messageId) == ["r5", "r7"])
        #expect(state.unreadReplyCount == 4)
        #expect(state.unacknowledgedNotificationIds == ["n-old", "n6"])
    }

    @Test("カーソルが null なら、すべての返事が未読")
    func noCursor() {
        var state = ConversationState()
        state.apply(snapshot([owner("m1", event: "e1"), reply("r2", to: "e1")], readThrough: nil, unread: 1))
        #expect(state.unreadReplies.map(\.messageId) == ["r2"])
        #expect(state.unreadReplyCount == 1)
    }

    @Test("snapshot は前の既読と確認の状態を置き換える")
    func snapshotReplaces() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1"), reply("r2")], readThrough: nil, unread: 2))
        state.apply(.message(notice("n3")))
        #expect(state.unacknowledgedNotificationIds == ["n3"])
        state.apply(snapshot([reply("r1"), reply("r2"), notice("n3")], readThrough: "r2", unread: 0))
        #expect(state.unreadReplies.isEmpty)
        #expect(state.unreadReplyCount == 0)
        #expect(state.unacknowledgedNotificationIds.isEmpty)
    }

    @Test("新しい返事は未読に、新しい知らせは未確認に加わる。本人のメッセージは数えず、同じ ID は二重に数えない")
    func newMessages() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1")], readThrough: "r1", unread: 0))
        state.apply(.message(owner("m2", event: "e2")))
        state.apply(.message(notice("n3")))
        state.apply(.message(notice("n3")))
        state.apply(.message(reply("r4", to: "e2")))
        state.apply(.message(reply("r4", to: "e2")))
        #expect(state.unreadReplies.map(\.messageId) == ["r4"])
        #expect(state.unreadReplyCount == 1)
        #expect(state.unacknowledgedNotificationIds == ["n3"])
    }

    @Test("一覧より古い未読があるときも、新しい返事で件数が 1 増える")
    func newReplyWithOlderUnread() {
        var state = ConversationState()
        state.apply(snapshot([reply("r5")], readThrough: "r0", unread: 3))
        state.apply(.message(reply("r6")))
        #expect(state.unreadReplies.map(\.messageId) == ["r5", "r6"])
        #expect(state.unreadReplyCount == 4)
    }

    @Test("conversation.read のイベントで、ほかの端末が進めたカーソルと件数に置き換える。知らせは確認済みにならない")
    func readEvent() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1"), notice("n2"), reply("r3"), reply("r4")], readThrough: nil, unread: 3, notices: ["n2"]))
        state.apply(.readMoved(readThroughMessageId: "r3", unreadReplyCount: 1))
        #expect(state.readState.readThroughMessageId == "r3")
        #expect(state.unreadReplies.map(\.messageId) == ["r4"])
        #expect(state.unreadReplyCount == 1)
        #expect(state.unacknowledgedNotificationIds == ["n2"])
    }

    @Test("notification.acked のイベントで、ほかの端末が確認した知らせを外す。知らない ID は無視する")
    func ackedEvent() {
        var state = ConversationState()
        state.apply(snapshot([notice("n1"), notice("n2")], readThrough: nil, unread: 0, notices: ["n1", "n2"]))
        state.apply(.notificationAcked(notificationId: "n1"))
        #expect(state.unacknowledgedNotificationIds == ["n2"])
        state.apply(.notificationAcked(notificationId: "unknown"))
        #expect(state.unacknowledgedNotificationIds == ["n2"])
    }

    @Test("返事の確認は応答を待たずに見た目へ反映し、受付で手元の変更を外してサーバーの値を使う")
    func optimisticRead() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1"), reply("r2"), reply("r3")], readThrough: nil, unread: 3))
        state.markRead(through: "r1", requestId: "q1")
        #expect(state.unreadReplies.map(\.messageId) == ["r2", "r3"])
        #expect(state.unreadReplyCount == 2)
        #expect(state.readState.readThroughMessageId == nil)
        #expect(state.localReadChanges == [ReadChange(requestId: "q1", kind: .read(throughMessageId: "r1"))])

        state.apply(.accepted(CommandAccepted(readThroughMessageId: "r1", unreadReplyCount: 2)), requestId: "q1")
        #expect(state.localReadChanges.isEmpty)
        #expect(state.readState.readThroughMessageId == "r1")
        #expect(state.unreadReplies.map(\.messageId) == ["r2", "r3"])
    }

    @Test("知らせの確認も応答を待たずに外し、受付で確定する")
    func optimisticAck() {
        var state = ConversationState()
        state.apply(snapshot([notice("n1"), notice("n2")], readThrough: nil, unread: 0, notices: ["n1", "n2"]))
        state.markAcknowledged("n1", requestId: "q1")
        #expect(state.unacknowledgedNotificationIds == ["n2"])
        state.apply(.accepted(CommandAccepted(notificationId: "n1")), requestId: "q1")
        #expect(state.localReadChanges.isEmpty)
        #expect(state.unacknowledgedNotificationIds == ["n2"])
    }

    @Test("拒否やサービス停止では手元の変更を捨ててサーバーの状態に戻り、その後の snapshot が正になる")
    func rejectedReverts() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1"), notice("n2"), reply("r3")], readThrough: nil, unread: 2, notices: ["n2"]))
        state.markRead(through: "r1", requestId: "q1")
        state.markAcknowledged("n2", requestId: "q2")
        #expect(state.unreadReplies.map(\.messageId) == ["r3"])
        #expect(state.unacknowledgedNotificationIds.isEmpty)

        state.apply(.rejected(code: "invalid-request"), requestId: "q1")
        state.apply(.unavailable(code: "stopping", deviceId: nil), requestId: "q2")
        #expect(state.localReadChanges.isEmpty)
        #expect(state.unreadReplies.map(\.messageId) == ["r1", "r3"])
        #expect(state.unreadReplyCount == 2)
        #expect(state.unacknowledgedNotificationIds == ["n2"])

        state.apply(snapshot([reply("r1"), notice("n2"), reply("r3")], readThrough: "r1", unread: 1, notices: []))
        #expect(state.unreadReplies.map(\.messageId) == ["r3"])
        #expect(state.unacknowledgedNotificationIds.isEmpty)
    }

    @Test("履歴の印のために、未読の返事と未確認の知らせを見分けられる")
    func marks() {
        var state = ConversationState()
        state.apply(snapshot([reply("r1"), notice("n2"), reply("r3")], readThrough: "r1", unread: 1, notices: ["n2"]))
        #expect(state.isUnread(reply("r1")) == false)
        #expect(state.isUnread(reply("r3")))
        #expect(state.isUnread(notice("n2")))
        state.markAcknowledged("n2", requestId: "q1")
        #expect(state.isUnread(notice("n2")) == false)
    }

    @Test("履歴のすべての行の印を、行ごとと同じ答えでまとめて出せる")
    func allMarks() {
        var state = ConversationState()
        state.apply(snapshot(
            [owner("m0", event: "e0"), reply("r1"), notice("n2"), reply("r3"), notice("n4")],
            readThrough: "r1", unread: 1, notices: ["n2", "n4"]))
        #expect(state.unreadFlags == [false, false, true, true, true])
        state.markRead(through: "r3", requestId: "q1")
        state.markAcknowledged("n4", requestId: "q2")
        #expect(state.unreadFlags == [false, false, true, false, false])
        #expect(state.unreadFlags == state.messages.map(state.isUnread))
    }
}

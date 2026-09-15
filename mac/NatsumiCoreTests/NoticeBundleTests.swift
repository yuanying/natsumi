import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("知らせの束とキャラの印")
struct NoticeBundleTests {
    private func reply(_ id: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: "こんにちは", createdAt: "2026-01-01T00:00:01.000Z", replyTo: "e0")
    }

    private func notice(_ id: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: "架空のお知らせ", createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func conversation(_ messages: [ShownMessage], notices: [String]) -> ConversationState {
        var state = ConversationState()
        state.apply(.snapshot(Snapshot(
            deviceId: "d", messages: messages, pendingEvents: [], expression: .neutral,
            readState: ReadState(readThroughMessageId: messages.last?.messageId, unreadReplyCount: 0, unacknowledgedNotificationIds: notices))))
        return state
    }

    @Test("未確認が無ければ、束も印も出さない")
    func empty() {
        var bundle = NoticeBundleState()
        bundle.update(with: conversation([notice("n1")], notices: []))
        #expect(bundle.stack == nil)
        #expect(bundle.isShown == false)
        #expect(bundle.badgeCount == 0)
    }

    @Test("未確認の知らせを古い順に束にし、件数を印にする。返事は入れない")
    func stack() {
        var bundle = NoticeBundleState()
        bundle.update(with: conversation([notice("n1"), reply("r2"), notice("n3"), notice("n4"), notice("n5")], notices: ["n1", "n3", "n4", "n5"]))
        let stack = bundle.stack
        #expect(stack?.front == .notice(notice("n1")))
        #expect(stack?.frontIds == ["n1"])
        #expect(stack?.count == 4)
        #expect(stack?.more == 3)
        #expect(stack?.behind == NoticeStack.maxBehind)
        #expect(bundle.isShown)
        #expect(bundle.badgeCount == 4)
    }

    @Test("一覧の外の知らせは、本文の無い「古い知らせ」の 1 枚にまとめる")
    func older() {
        var bundle = NoticeBundleState()
        bundle.update(with: conversation([reply("r4"), notice("n5")], notices: ["n1", "n2", "n5"]))
        let stack = bundle.stack
        #expect(stack?.front == .older(ids: ["n1", "n2"]))
        #expect(stack?.frontIds == ["n1", "n2"])
        #expect(stack?.count == 3)
        #expect(stack?.more == 1)
        #expect(stack?.behind == 1)
        #expect(bundle.badgeCount == 3)
    }

    @Test("前の知らせを確かめると次を前に出し、印の件数が減る。最後を確かめたら束を閉じる")
    func acknowledgeFront() {
        var state = conversation([notice("n1"), notice("n2")], notices: ["n1", "n2"])
        var bundle = NoticeBundleState()
        bundle.update(with: state)
        state.markAcknowledged("n1", requestId: "q1")
        bundle.update(with: state)
        #expect(bundle.stack?.front == .notice(notice("n2")))
        #expect(bundle.badgeCount == 1)
        state.markAcknowledged("n2", requestId: "q2")
        bundle.update(with: state)
        #expect(bundle.stack == nil)
        #expect(bundle.badgeCount == 0)
    }

    @Test("ほかの端末で確認された知らせは、束から外れる")
    func ackedElsewhere() {
        var state = conversation([notice("n1"), notice("n2")], notices: ["n1", "n2"])
        var bundle = NoticeBundleState()
        bundle.update(with: state)
        state.apply(.notificationAcked(notificationId: "n1"))
        bundle.update(with: state)
        #expect(bundle.stack?.front == .notice(notice("n2")))
        #expect(bundle.badgeCount == 1)
    }

    @Test("印のクリックで束を隠し、もう一度で出す。隠しても確認にはならない")
    func toggle() {
        let state = conversation([notice("n1")], notices: ["n1"])
        var bundle = NoticeBundleState()
        bundle.update(with: state)
        bundle.toggle()
        #expect(bundle.isShown == false)
        #expect(bundle.badgeCount == 1)
        bundle.update(with: state)
        #expect(bundle.isShown == false)
        #expect(state.unacknowledgedNotificationIds == ["n1"])
        bundle.toggle()
        #expect(bundle.isShown)
    }

    @Test("隠している間に新しい知らせが届くと、束をまた出す")
    func newNoticeShowsAgain() {
        var state = conversation([notice("n1")], notices: ["n1"])
        var bundle = NoticeBundleState()
        bundle.update(with: state)
        bundle.toggle()
        state.apply(.message(notice("n2")))
        bundle.update(with: state)
        #expect(bundle.isShown)
        #expect(bundle.badgeCount == 2)
    }

    @Test("印は、キャラの右上に、倍率に合わせた大きさで置く")
    func badgeFrame() {
        #expect(CharacterBadge.frame(for: CharacterScale(1)) == CGRect(x: 96 - 22, y: 0, width: 22, height: 22))
        #expect(CharacterBadge.frame(for: CharacterScale(2)) == CGRect(x: 192 - 44, y: 0, width: 44, height: 44))
        // Small characters keep a badge large enough to read and click.
        #expect(CharacterBadge.frame(for: CharacterScale(0.5)) == CGRect(x: 48 - 14, y: 0, width: 14, height: 14))
    }
}

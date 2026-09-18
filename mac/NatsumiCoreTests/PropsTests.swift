import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("描画パラメータの導出")
struct PropsTests {
    private func owner(_ id: String, event: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String = "e0", text: String = "こんにちは") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .reply, text: text, createdAt: "2026-01-01T00:00:01.000Z", replyTo: event)
    }

    private func notice(_ id: String, text: String = "架空のお知らせ") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: text, createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func conversation(
        _ messages: [ShownMessage], readThrough: String? = nil, unread: Int = 0, notices: [String] = [],
        pending: [PendingEvent] = []
    ) -> ConversationState {
        var state = ConversationState()
        state.apply(.snapshot(Snapshot(
            deviceId: "d", messages: messages, pendingEvents: pending, expression: .neutral,
            readState: ReadState(
                readThroughMessageId: readThrough, unreadReplyCount: unread, unacknowledgedNotificationIds: notices))))
        return state
    }

    private func balloon(
        _ conversation: ConversationState, dismissed: BalloonIndicator? = nil, placement: ColumnPlacement = ColumnPlacement()
    ) -> BalloonProps? {
        UIProps.balloon(conversation, dismissed: dismissed, placement: placement, scale: .default)
    }

    private func notices(
        _ conversation: ConversationState, hidden: Bool = false, placement: ColumnPlacement = ColumnPlacement()
    ) -> NoticeBundleProps? {
        UIProps.notices(conversation, hidden: hidden, placement: placement, scale: .default)
    }

    // MARK: - The balloon

    @Test("何も話していなければ、吹き出しは出さない")
    func hiddenWhenEmpty() {
        #expect(balloon(ConversationState()) == nil)
    }

    @Test("未読の返事を古い順に前へ出し、件数を持つ。本人のメッセージと知らせは入れない")
    func oldestFirst() {
        let state = conversation(
            [reply("r0"), owner("m1", event: "e1"), notice("n2"), reply("r3", to: "e1"), reply("r4"), reply("r5"), reply("r6")],
            readThrough: "r0", unread: 4)
        #expect(UIProps.replyStack(state) == ReplyStack(front: reply("r3", to: "e1"), count: 4))
        let props = balloon(state)
        #expect(props?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 3, help: "クリックで全文を出す")))
        #expect(props?.edges == ReplyStack.maxBehind)
        #expect(props?.closeHelp == "この返事を既読にして次へ")
        #expect(props?.isBusy == false)
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
        let state = conversation([reply("r5"), reply("r6")], readThrough: "r0", unread: 5)
        #expect(UIProps.replyStack(state) == ReplyStack(front: reply("r5"), count: 5))
        #expect(balloon(state)?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 4, help: "クリックで全文を出す")))
    }

    @Test("高さが足りないときは、重ねる枚数と行数を減らし、続きを履歴へ送る")
    func budget() {
        let state = conversation([reply("r1"), reply("r2"), reply("r3")], readThrough: nil, unread: 3)
        var placement = ColumnPlacement()
        placement.budget = StackBudget(behind: 0, lines: 2)
        let props = balloon(state, placement: placement)
        #expect(props?.edges == 0)
        #expect(props?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: 2, showsHistoryLink: true, more: 2, help: "クリックで全文を出す")))
    }

    @Test("長い発言は切って、続きは履歴で読めることを示す")
    func truncated() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1", text: long)], readThrough: nil, unread: 1)
        #expect(balloon(state)?.body == .reply(ReplyProps(
            text: String(repeating: "あ", count: BalloonText.maxCharacters) + "…", lineLimit: BalloonText.maxLines,
            showsHistoryLink: true, more: 0, help: "クリックで全文を出す")))
    }

    @Test("開いたカードは横にも広がり、閉じているカードと入力欄は今までの幅のまま")
    func expandedIsWider() {
        let screen = CGRect(x: 0, y: 0, width: 1710, height: 950)
        let column = CGFloat(InputBoxSize.default.width)
        let wide = OverlayLayout.expandedWidth(column, visible: screen)
        #expect(wide == column * OverlayLayout.expandedWidthFactor)
        // 画面が狭ければ、そこで止まる。
        let narrow = CGRect(x: 0, y: 0, width: 400, height: 900)
        #expect(OverlayLayout.expandedWidth(column, visible: narrow) == 400 - OverlayLayout.expandedSideMargin * 2)
        // 画面の端にいても同じだけ広がる。はみ出す分は配置が内側にずらし、しっぽはキャラクターの中心を指したままになる。
        let atEdge = CGRect(x: 1493, y: 90, width: 192, height: 208)
        #expect(OverlayLayout.expandedWidth(column, visible: screen) == wide)
        let layout = OverlayLayout.make(
            visible: screen, character: atEdge, spacing: 8, notices: nil, balloon: CGSize(width: wide, height: 120),
            input: nil, history: nil)
        #expect(layout.balloon?.maxX == screen.maxX)
        #expect(layout.balloon.map { $0.minX + layout.tailX } == atEdge.midX)

        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        placement.width = column
        placement.expandedWidth = wide
        let state = conversation([reply("r1"), notice("n1")], readThrough: nil, unread: 1, notices: ["n1"])
        #expect(UIProps.balloon(state, dismissed: nil, expanded: .reply("r1"), placement: placement, scale: .default)?
            .width == wide)
        #expect(UIProps.balloon(state, dismissed: nil, expanded: nil, placement: placement, scale: .default)?
            .width == column)
        #expect(UIProps.notices(state, hidden: false, expanded: .notice("n1"), placement: placement, scale: .default)?
            .width == wide)
        #expect(UIProps.notices(state, hidden: false, expanded: nil, placement: placement, scale: .default)?
            .width == column)
    }

    @Test("拡大した返事は全文を出し、切られていなければ履歴へは誘導しない")
    func expandedReply() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1", text: long)], readThrough: nil, unread: 1)
        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        let props = UIProps.balloon(
            state, dismissed: nil, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.body == .reply(ReplyProps(
            text: long, lineLimit: BalloonText.expandedMaxLines, isExpanded: true, showsHistoryLink: false, more: 0,
            help: "クリックで畳む")))
    }

    @Test("拡大しても画面に入らないときは、そこで切って「続きは履歴で」を出したままにする")
    func expandedReplyStillCut() {
        let many = (1...(BalloonText.expandedMaxLines + 5)).map { "行\($0)" }.joined(separator: "\n")
        let state = conversation([reply("r1", text: many)], readThrough: nil, unread: 1)
        var placement = ColumnPlacement()
        placement.budget = StackBudget(behind: 0, lines: 12)
        let props = UIProps.balloon(
            state, dismissed: nil, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.body == .reply(ReplyProps(
            text: many, lineLimit: 12, isExpanded: true, showsHistoryLink: true, more: 0, help: "クリックで畳む")))
    }

    @Test("拡大していない側のカードは、切った本文と 5 行までのまま")
    func othersKeepThePreview() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1"), notice("n1", text: long)], readThrough: nil, unread: 1, notices: ["n1"])
        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        let props = UIProps.notices(
            state, hidden: false, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.isExpanded == false)
        #expect(props?.lineLimit == BalloonText.maxLines)
        #expect(props?.text == String(repeating: "あ", count: BalloonText.maxCharacters) + "…")
        #expect(props?.showsHistoryLink == true)
    }

    @Test("拡大したときの行数の梯子は、上から下へ狭くなる")
    func expandedLadder() {
        #expect(StackBudget.expandedSteps.first?.lines == BalloonText.expandedMaxLines)
        #expect(StackBudget.expandedSteps.last == StackBudget.steps.last)
        #expect(StackBudget.expandedSteps.map(\.lines) == StackBudget.expandedSteps.map(\.lines).sorted(by: >))
    }

    @Test("返事の未読が無く処理待ちがあるときだけ考え中を出し、未読があれば未読を出して処理中の印を付ける")
    func indicators() {
        var state = conversation([reply("r0")], readThrough: "r0")
        state.enqueue(text: "やあ", requestId: "q1")
        #expect(balloon(state)?.body == .receiving)
        #expect(balloon(state)?.closeHelp == "閉じる")

        state.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .processing)), requestId: "q1")
        #expect(balloon(state)?.body == .thinking)

        // A notice is not a reply: the balloon keeps thinking.
        state.apply(.message(notice("n1")))
        #expect(balloon(state)?.body == .thinking)

        state.apply(.message(reply("r2", to: "e1")))
        #expect(balloon(state)?.isBusy == true)
        state.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .replied, reason: nil)))
        #expect(balloon(state)?.isBusy == false)
    }

    @Test("閉じた印は出さないが、未読の返事は閉じても出し続ける")
    func dismissed() {
        let thinking = conversation(
            [owner("m1", event: "e1")], readThrough: "m1",
            pending: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)])
        #expect(balloon(thinking, dismissed: .thinking) == nil)
        #expect(balloon(thinking, dismissed: .receiving)?.body == .thinking)

        let unread = conversation([reply("r1")], readThrough: nil, unread: 1)
        #expect(balloon(unread, dismissed: .thinking)?.body != nil)
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

    // MARK: - The notices

    @Test("未確認が無ければ、束も印も出さない")
    func noNotices() {
        let state = conversation([notice("n1")], readThrough: "n1")
        #expect(UIProps.noticeStack(state) == nil)
        #expect(notices(state) == nil)
        #expect(UIProps.character(
            UIState(session: SessionMachine(deviceId: nil)), stack: nil).badge == nil)
    }

    @Test("未確認の知らせを古い順に束にし、件数を印にする。返事は入れない")
    func noticeStack() {
        let state = conversation(
            [notice("n1"), reply("r2"), notice("n3"), notice("n4"), notice("n5")],
            readThrough: "n5", notices: ["n1", "n3", "n4", "n5"])
        let stack = UIProps.noticeStack(state)
        #expect(stack == NoticeStack(front: .notice(notice("n1")), frontIds: ["n1"], count: 4, cards: 4))
        #expect(stack?.behind == NoticeStack.maxBehind)
        let props = notices(state)
        #expect(props == NoticeBundleProps(
            text: "架空のお知らせ", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 3,
            help: "クリックで全文を出す", closeHelp: "この知らせを確認して次へ", edges: NoticeStack.maxBehind, edgesUpward: true,
            width: ColumnPlacement().width, textScale: CharacterScale.default.textScale))
    }

    @Test("一覧の外の知らせは、本文の無い 1 枚にまとめ、履歴へは誘導しない")
    func olderNotices() {
        let state = conversation([reply("r4"), notice("n5")], readThrough: "n5", notices: ["n1", "n2", "n5"])
        let stack = UIProps.noticeStack(state)
        #expect(stack == NoticeStack(front: .older(ids: ["n1", "n2"]), frontIds: ["n1", "n2"], count: 3, cards: 2))
        #expect(stack?.more == 1)
        let props = notices(state)
        #expect(props?.text == "前の知らせが 2 件あります（本文は履歴より前のため出せません）")
        #expect(props?.showsHistoryLink == false)
        #expect(props?.help == "クリックでまとめて確かめる")
        // The card has no body to open, so its × means the same as a click on it.
        #expect(props?.closeHelp == "まとめて確認して次へ")
        #expect(props?.isExpanded == false)
    }

    @Test("隠している間は束を出さないが、印は件数を出し続ける")
    func hiddenNotices() {
        let state = conversation([notice("n1")], readThrough: "n1", notices: ["n1"])
        #expect(notices(state, hidden: true) == nil)
        #expect(notices(state, hidden: false) != nil)
    }

    @Test("一列を反転すると、後ろのカードはキャラから離れる向きに動く")
    func flippedNotices() {
        let state = conversation([notice("n1"), notice("n2")], readThrough: "n2", notices: ["n1", "n2"])
        var placement = ColumnPlacement()
        placement.tail = .up
        #expect(notices(state, placement: placement)?.edgesUpward == false)
        #expect(notices(state)?.edgesUpward == true)
    }

    @Test("印は、キャラの右上に、倍率に合わせた大きさで置く")
    func badgeFrame() {
        #expect(CharacterBadge.frame(for: CharacterScale(1)) == CGRect(x: 96 - 22, y: 0, width: 22, height: 22))
        #expect(CharacterBadge.frame(for: CharacterScale(2)) == CGRect(x: 192 - 44, y: 0, width: 44, height: 44))
        // Small characters keep a badge large enough to read and click.
        #expect(CharacterBadge.frame(for: CharacterScale(0.5)) == CGRect(x: 48 - 14, y: 0, width: 14, height: 14))
    }

    // MARK: - The input field and the history

    @Test("送れなかった送信は入力欄に、受付中と併せて履歴に出る")
    func failures() {
        var state = ConversationState()
        state.enqueue(text: "架空のメッセージ", requestId: "q1")
        state.enqueue(text: "もう一つ", requestId: "q2")
        state.apply(.rejected(code: "invalid"), requestId: "q2")
        let input = UIProps.input(state, status: .connected, scale: .default, boxSize: .default, textHeight: 0)
        #expect(input.failures == [FailureProps(requestId: "q2", text: "「もう一つ」を送れませんでした（invalid）")])
        #expect(input.status == nil)

        let history = UIProps.history(state, status: .connected)
        #expect(history.outgoing == [
            OutgoingRowProps(requestId: "q1", text: "架空のメッセージ", failure: nil),
            OutgoingRowProps(requestId: "q2", text: "もう一つ", failure: "送れませんでした（invalid）"),
        ])
    }

    @Test("履歴は未読の返事と未確認の知らせに印を付ける")
    func historyRows() {
        let state = conversation(
            [owner("m1", event: "e1"), reply("r2", to: "e1"), notice("n3")],
            readThrough: "m1", unread: 1, notices: ["n3"])
        let rows = UIProps.history(state, status: .connected).rows
        #expect(rows == [
            HistoryRowProps(messageId: "m1", text: "やあ", isOwner: true, isNotice: false, isUnread: false),
            HistoryRowProps(messageId: "r2", text: "こんにちは", isOwner: false, isNotice: false, isUnread: true),
            HistoryRowProps(messageId: "n3", text: "架空のお知らせ", isOwner: false, isNotice: true, isUnread: true),
        ])
    }

    @Test("接続していないときの案内は、状態ごとに次の一手を持つ")
    func statusRow() {
        func action(_ status: ConnectionStatus) -> ActionProps? {
            UIProps.input(ConversationState(), status: status, scale: .default, boxSize: .default, textHeight: 0).status?.action
        }
        #expect(action(.needsServer) == ActionProps(title: "設定を開く", event: .settingsOpenRequested))
        #expect(action(.needsLogin) == ActionProps(title: "GitHub でログイン", event: .loginRequested))
        #expect(action(.stopped) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.unavailable("架空")) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.replaced) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.connecting) == nil)
    }
}

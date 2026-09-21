import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("UI の裁定（Mediator）")
struct UIMediatorTests {
    private static let server = "https://natsumi.example.net"

    private func launched(server: String? = server, hasSession: Bool = true) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: server,
            avatarDirectory: "/tmp/avatar", defaultAvatarDirectory: "/tmp/avatar")))
        _ = mediator.handle(.sessionResumed(hasSession: hasSession, deviceId: nil))
        return mediator
    }

    /// A mediator that is synced with the server, with the given messages already in the conversation.
    private func synced(
        messages: [[String: Any]] = [], readThrough: String? = nil, unread: Int = 0, unacknowledged: [String] = []
    ) -> UIMediator {
        var mediator = launched()
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages,
            readThrough: readThrough, unreadReplyCount: unread, unacknowledged: unacknowledged)))
        return mediator
    }

    /// The drawing parameters as the root derives them when the whole column fits: the first step of the ladder the
    /// state asks for.
    private func props(_ mediator: UIMediator) -> RootProps {
        var placement = ColumnPlacement()
        placement.budget = UIProps.budgetSteps(mediator.state)[0]
        return UIProps.root(mediator.state, placement: placement)
    }

    private func sent(_ effects: [UIEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope } else { nil } }
    }

    // MARK: - Panels

    private let screen = CGRect(x: 0, y: 0, width: 1600, height: 1000)
    private let character = CGRect(x: 800, y: 500, width: 96, height: 104)

    /// A mediator whose character stands in the middle of a screen.
    private func placed() -> UIMediator {
        var mediator = launched()
        _ = mediator.handle(.characterFrameChanged(character, visible: screen))
        return mediator
    }

    @Test("キャラのクリックで会話のウインドウを開き、もう一度のクリックで消す。初回はキャラの真下に置き、それを覚える")
    func clickTogglesTheConversation() {
        var mediator = placed()
        #expect(props(mediator).conversation == nil)
        let opened = mediator.handle(.characterClicked)
        let window = try! #require(props(mediator).conversation)
        let size = ConversationWindow.default.size
        #expect(window.frame == CGRect(
            x: character.midX - size.width / 2, y: character.minY - 8 - size.height,
            width: size.width, height: size.height))
        #expect(window.history == nil)
        #expect(window.status == StatusProps(text: ConnectionStatus.connecting.text, action: nil))
        #expect(opened == [.focusInput, .saveConversationWindow(mediator.state.conversationWindow)])
        #expect(mediator.handle(.characterClicked).isEmpty)
        #expect(props(mediator).conversation == nil)
        // The next time it comes back to where it was, wherever she is now.
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: -500, dy: 0), visible: screen))
        #expect(mediator.handle(.characterClicked) == [.focusInput])
        #expect(props(mediator).conversation?.frame == window.frame)
    }

    @Test("⌘W で消える。Esc とアプリの外のクリックでは消えない（そのイベントはもう無い）")
    func closeRequested() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        #expect(mediator.handle(.conversationCloseRequested).isEmpty)
        #expect(props(mediator).conversation == nil)
        #expect(mediator.handle(.conversationCloseRequested).isEmpty)
    }

    @Test("メニューから話しかけると、消えていても覚えている状態で開く。開いていれば何もしない")
    func talkOpensTheConversation() {
        var mediator = placed()
        #expect(mediator.handle(.talkRequested).contains(.focusInput))
        #expect(mediator.handle(.talkRequested).isEmpty)
        #expect(props(mediator).conversation?.history == nil)
        _ = mediator.handle(.historyToggleRequested)
        _ = mediator.handle(.conversationCloseRequested)
        #expect(mediator.handle(.talkRequested) == [.focusInput])
        #expect(props(mediator).conversation?.history != nil)
    }

    @Test("ひらく⇔とじるは履歴を畳んだり開いたりするだけで、ウインドウは消えない。消えている間は何もしない")
    func toggleHistory() {
        var mediator = placed()
        #expect(mediator.handle(.historyToggleRequested).isEmpty)
        _ = mediator.handle(.characterClicked)
        let folded = try! #require(props(mediator).conversation)
        let effects = mediator.handle(.historyToggleRequested)
        let unfolded = try! #require(props(mediator).conversation)
        #expect(unfolded.history != nil)
        #expect(unfolded.frame.midY == folded.frame.midY)
        #expect(unfolded.frame.height == ConversationWindow.default.unfoldedHeight)
        #expect(unfolded.foldedHeight == folded.frame.height)
        #expect(unfolded.toggleHelp == "履歴をとじる（⌘L）")
        #expect(effects == [.saveConversationWindow(mediator.state.conversationWindow)])
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation == folded)
    }

    @Test("「履歴を開く」と「続きは履歴で」は、ウインドウを出して履歴を開く。開いていれば何もしない")
    func historyRequested() {
        var mediator = placed()
        let effects = mediator.handle(.historyOpenRequested)
        #expect(effects.first == .focusInput)
        #expect(props(mediator).conversation?.history != nil)
        #expect(mediator.handle(.historyLinkClicked).isEmpty)
        _ = mediator.handle(.conversationCloseRequested)
        #expect(mediator.handle(.historyLinkClicked) == [.focusInput])
        #expect(props(mediator).conversation?.history != nil)
    }

    @Test("動かした・大きさを変えたウインドウは、その幅といまの状態の高さを覚えて保存する")
    func frameChanged() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        let moved = CGRect(x: 10, y: 20, width: 400, height: 200)
        #expect(mediator.handle(.conversationFrameChanged(moved, visible: screen))
            == [.saveConversationWindow(mediator.state.conversationWindow)])
        #expect(props(mediator).conversation?.frame == moved)
        #expect(mediator.handle(.conversationFrameChanged(moved, visible: screen)).isEmpty)
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation?.frame.width == 400)
        #expect(props(mediator).conversation?.foldedHeight == 200)
        #expect(props(mediator).conversation?.frame.height == ConversationWindow.default.unfoldedHeight)
    }

    @Test("開くときの上下の余裕は、ウインドウのある画面で見る")
    func unfoldsOnTheWindowsScreen() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        let other = CGRect(x: 1600, y: 0, width: 1000, height: 300)
        _ = mediator.handle(.conversationFrameChanged(CGRect(x: 1700, y: 50, width: 320, height: 140), visible: other))
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation?.frame == CGRect(x: 1700, y: 0, width: 320, height: 300))
    }

    @Test("設定は開く指示と閉じる指示を出す")
    func settings() {
        var mediator = launched()
        #expect(mediator.handle(.settingsOpenRequested) == [.showSettings])
        #expect(props(mediator).isSettingsOpen)
        #expect(mediator.handle(.settingsCloseRequested) == [.hideSettings])
        #expect(props(mediator).isSettingsOpen == false)
    }

    // MARK: - Conversation

    @Test("送信は受付中の吹き出しになり、空白だけの送信はしない")
    func send() {
        var mediator = synced()
        #expect(mediator.handle(.inputSubmitted("   ")).isEmpty)
        #expect(props(mediator).balloon == nil)

        let effects = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(sent(effects).count == 1)
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
        #expect(props(mediator).balloon?.outline == .thought)
    }

    @Test("本文のクリックは全文を出すだけで、× が 1 件ずつ既読にして次を前に出す")
    func readReplies() {
        var mediator = synced(
            messages: [Fixture.message("r1"), Fixture.message("r2")], readThrough: nil, unread: 2)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, isExpanded: false, showsHistoryLink: false, more: 1,
            help: "クリックで全文を出す")))
        #expect(props(mediator).balloon?.closeHelp == "この返事を既読にして次へ")

        // Expanding tells the server nothing: only the × reads.
        let expanded = mediator.handle(.balloonTextClicked)
        #expect(sent(expanded).isEmpty)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.expandedMaxLines, isExpanded: true, showsHistoryLink: false,
            more: 1, help: "クリックで畳む")))

        let one = mediator.handle(.balloonCloseClicked)
        #expect(sent(one).count == 1)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, isExpanded: false, showsHistoryLink: false, more: 0,
            help: "クリックで全文を出す")))
        #expect(props(mediator).balloon?.closeHelp == "この返事を既読にして閉じる")

        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)
    }

    @Test("前に出ている返事が変わると、拡大は畳む")
    func expandedFoldsWithTheFrontReply() {
        var mediator = synced(
            messages: [Fixture.message("r1"), Fixture.message("r2")], readThrough: nil, unread: 2)
        _ = mediator.handle(.balloonTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == true)
        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon?.body.isExpanded == false)
    }

    @Test("拡大しているのは一度に 1 件で、別の本文を開くと前のは畳む")
    func onlyOneExpanded() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(
            messages: [Fixture.message("r1"), notice], readThrough: nil, unread: 1, unacknowledged: ["n1"])
        _ = mediator.handle(.balloonTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == true)
        #expect(props(mediator).notices?.isExpanded == false)

        _ = mediator.handle(.noticeTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == false)
        #expect(props(mediator).notices?.isExpanded == true)

        // The same body again folds it.
        _ = mediator.handle(.noticeTextClicked)
        #expect(props(mediator).notices?.isExpanded == false)
    }

    @Test("閉じた「考え中」は、その 1 回の処理が終わるまで出さない")
    func dismissThinking() {
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", eventId: "e1")],
            readThrough: "m1")
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2,
            payload: Fixture.message("m2", role: "owner", kind: "message", eventId: "e2"))))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: nil)))

        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)

        // One handling is one thing she is saying: the lines that follow, and the reply she sends, stay hidden.
        _ = mediator.handle(.socketReceived(Fixture.thinking("考えている", seq: 2)))
        #expect(props(mediator).balloon == nil)
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 3, payload: Fixture.message("r3", text: "架空の返事", replyTo: "e2"))))
        #expect(props(mediator).balloon == nil)

        // It is over when she has nothing left to handle, and the unread reply comes forward.
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.event.completed", seq: 4, payload: ["eventId": "e2", "messageId": "m2", "status": "replied"])))
        if case .reply = props(mediator).balloon?.body {} else { Issue.record("返事が出ていない") }
    }

    @Test("閉じた「受付中」は、続けて始まった「考え中」でも出し直さない")
    func dismissCarriesFromReceivingToThinking() {
        var mediator = synced(messages: [], readThrough: nil)
        _ = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "command.accepted", seq: 2, requestId: "r2",
            payload: ["messageId": "m1", "eventId": "e1", "state": "processing"])))
        #expect(props(mediator).balloon == nil)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.event.completed", seq: 3, payload: ["eventId": "e1", "messageId": "m1", "status": "no-reply"])))
        // Nothing is left to handle, so the next message opens the bubble again.
        _ = mediator.handle(.inputSubmitted("もう一度"))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
    }

    @Test("印のクリックで知らせの束を隠し、新しい知らせが来るとまた出す")
    func toggleNotices() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(messages: [notice], unacknowledged: ["n1"])
        #expect(props(mediator).notices != nil)
        #expect(props(mediator).character.badge?.count == 1)

        #expect(mediator.handle(.badgeClicked).isEmpty)
        #expect(props(mediator).notices == nil)
        // Hiding checks nothing: the badge still counts it.
        #expect(props(mediator).character.badge?.count == 1)

        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        _ = mediator.handle(.socketReceived(Fixture.envelope("conversation.message", seq: 2, payload: second)))
        #expect(props(mediator).notices != nil)
        #expect(props(mediator).character.badge?.count == 2)
    }

    @Test("知らせの本文のクリックは全文を出すだけで、× が 1 件ずつ確かめる")
    func acknowledgeNotices() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        var mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(props(mediator).notices?.closeHelp == "この知らせを確認して次へ")
        #expect(sent(mediator.handle(.noticeTextClicked)).isEmpty)
        #expect(props(mediator).character.badge?.count == 2)

        #expect(sent(mediator.handle(.noticeCloseClicked)).count == 1)
        #expect(props(mediator).character.badge?.count == 1)
        #expect(props(mediator).notices?.closeHelp == "この知らせを確認して閉じる")
        #expect(sent(mediator.handle(.noticeCloseClicked)).count == 1)
        #expect(props(mediator).notices == nil)
        #expect(props(mediator).character.badge == nil)
    }

    @Test("本文の無い「前の知らせ」の 1 枚だけは、クリックでまとめて確かめる")
    func olderNoticesAreCheckedByClicking() {
        var mediator = synced(messages: [Fixture.message("r1")], unacknowledged: ["n0", "n1"])
        #expect(props(mediator).notices?.help == "クリックでまとめて確かめる")
        // One command per notice, as the contract has it; the card stands for both.
        #expect(sent(mediator.handle(.noticeTextClicked)).count == 2)
        #expect(props(mediator).notices == nil)
    }

    @Test("メニューの「すべて確認する」だけが、束をまとめて確かめる")
    func acknowledgeAllFromTheMenu() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        var mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(sent(mediator.handle(.acknowledgeAllNoticesRequested)).count == 2)
        #expect(props(mediator).notices == nil)
        #expect(props(mediator).character.badge == nil)
    }

    @Test("メニューの「すべて既読」「すべて確認」は、未読があるときだけ効く")
    func menuCommands() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(messages: [Fixture.message("r1"), notice], readThrough: nil, unread: 1, unacknowledged: ["n1"])
        #expect(props(mediator).menu.canReadAllReplies)
        #expect(props(mediator).menu.canAcknowledgeAllNotices)
        #expect(sent(mediator.handle(.readAllRepliesRequested)).count == 1)
        #expect(sent(mediator.handle(.acknowledgeAllNoticesRequested)).count == 1)
        #expect(props(mediator).menu.canReadAllReplies == false)
        #expect(props(mediator).menu.canAcknowledgeAllNotices == false)
        #expect(sent(mediator.handle(.readAllRepliesRequested)).isEmpty)
    }

    // MARK: - Server, login and settings

    @Test("サーバーが未設定なら、ログインを始めずに設定を促す")
    func loginWithoutServer() {
        var mediator = launched(server: nil, hasSession: false)
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsServer.text)
        #expect(mediator.handle(.loginRequested).isEmpty)
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsServer.text)
    }

    @Test("ログインを始めてから、失敗のわけを設定に出す")
    func loginFails() {
        var mediator = launched(hasSession: false)
        #expect(mediator.handle(.loginRequested) == [.startLogin])
        #expect(props(mediator).settings.statusText == ConnectionStatus.loggingIn.text)
        _ = mediator.handle(.loginFinished(.failed("ログインできませんでした（架空）")))
        #expect(props(mediator).settings.lastError == "ログインできませんでした（架空）")
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsLogin.text)

        _ = mediator.handle(.loginRequested)
        _ = mediator.handle(.loginFinished(.cancelled))
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsLogin.text)
    }

    @Test("ログアウトで接続を切り、会話を捨てる")
    func logout() {
        var mediator = synced(messages: [Fixture.message("r1")], readThrough: "r1")
        _ = mediator.handle(.historyOpenRequested)
        #expect(props(mediator).conversation?.history?.rows.count == 1)
        let effects = mediator.handle(.logoutRequested)
        #expect(effects.contains(.disconnect))
        #expect(effects.contains(.logout))
        #expect(props(mediator).conversation?.history?.rows.isEmpty == true)
        #expect(props(mediator).menu.canLogout == false)
    }

    @Test("接続先を保存するとつなぎ直し、誤った URL は保存せずに直し方を出す")
    func saveServer() {
        var mediator = launched()
        let effects = mediator.handle(.serverSubmitted("https://another.example.net"))
        #expect(effects.contains(.saveServerAddress(try! ServerAddress("https://another.example.net"))))
        #expect(effects.contains(.resumeSession))
        #expect(props(mediator).settings.serverOrigin == "https://another.example.net")
        #expect(props(mediator).settings.message == "保存しました")

        _ = mediator.handle(.serverSubmitted("http://example.net"))
        #expect(props(mediator).settings.serverOrigin == "https://another.example.net")
        #expect(props(mediator).settings.message?.contains("ループバック") == true)

        _ = mediator.handle(.serverSubmitted("だめな文字列"))
        #expect(props(mediator).settings.message?.contains("https://ホスト名") == true)
    }

    @Test("同じ接続先を保存し直しても、つなぎ直さない")
    func saveSameServer() {
        var mediator = launched()
        #expect(mediator.handle(.serverSubmitted(Self.server)).isEmpty)
        #expect(props(mediator).settings.message == "保存しました")
    }

    // MARK: - Size and avatar

    @Test("倍率は変わったときだけ保存する")
    func sizes() {
        var mediator = launched()
        #expect(mediator.handle(.characterScaleChanged(CharacterScale(1.5))) == [.saveCharacterScale(CharacterScale(1.5))])
        #expect(props(mediator).character.scale == CharacterScale(1.5))
        #expect(mediator.handle(.characterScaleChanged(CharacterScale(1.5))).isEmpty)
    }

    @Test("起動時に読んだ一列の幅と会話のウインドウは、そのまま描画に使う")
    func launchInfo() {
        var mediator = UIMediator { "r" }
        let window = ConversationWindow(
            origin: CGPoint(x: 30, y: 40), width: 400, foldedHeight: 150, unfoldedHeight: 600, showsHistory: true)
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, columnWidth: 360, conversationWindow: window, serverOrigin: nil,
            avatarDirectory: "/tmp/avatar", defaultAvatarDirectory: "/tmp/avatar")))
        #expect(props(mediator).balloon == nil)
        #expect(mediator.state.columnWidth == 360)
        #expect(mediator.handle(.characterClicked) == [.focusInput])
        #expect(props(mediator).conversation?.frame == CGRect(x: 30, y: 40, width: 400, height: 600))
        #expect(props(mediator).conversation?.history != nil)
    }

    @Test("アバターは読み込みを指示し、結果を受け取って描く")
    func avatar() {
        var mediator = launched()
        let effects = mediator.handle(.avatarDirectorySubmitted("/tmp/another"))
        #expect(effects == [.saveAvatarDirectory("/tmp/another"), .loadAvatar(directory: "/tmp/another")])
        _ = mediator.handle(.avatarLoaded(.placeholder, description: "架空の説明"))
        #expect(props(mediator).settings.avatarDescription == "架空の説明")
        #expect(mediator.handle(.avatarDirectoryResetRequested)
            == [.saveAvatarDirectory(nil), .loadAvatar(directory: "/tmp/avatar")])
    }

    // MARK: - Connection

    @Test("接続の状態は接続の状態機械から決まり、会話のウインドウの案内になる")
    func status() {
        var mediator = launched()
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.connecting.text)
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        #expect(props(mediator).character.disconnectedHelp == nil)

        _ = mediator.handle(.characterClicked)
        #expect(props(mediator).conversation?.status == StatusProps(text: ConnectionStatus.connected.text, action: nil))

        let effects = mediator.handle(.socketClosed(.code(1008)))
        #expect(effects.contains(.clearSession))
        #expect(props(mediator).conversation?.status
            == StatusProps(text: ConnectionStatus.needsLogin.text, action: ActionProps(title: "GitHub でログイン", event: .loginRequested)))
    }

    @Test("接続に使う資格が無くなったら、ログインを求めて止まる")
    func credentialsMissing() {
        var mediator = launched()
        _ = mediator.handle(.credentialsMissing)
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.needsLogin.text)
        #expect(props(mediator).menu.showsLogin)
    }

    @Test("再接続の待ちは、指示どおりに時間を置いてから接続し直す")
    func reconnect() {
        var mediator = launched()
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        let closed = mediator.handle(.socketClosed(.network))
        #expect(closed == [.disconnect, .scheduleReconnect(after: 1)])
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.reconnecting.text)
        #expect(mediator.handle(.reconnectTimerFired) == [.connect])
    }

    @Test("終了は、終了の指示だけを出す")
    func quit() {
        var mediator = launched()
        #expect(mediator.handle(.quitRequested) == [.terminate])
    }
}

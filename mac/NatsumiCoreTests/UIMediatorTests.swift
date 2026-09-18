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
            characterScale: .default, inputBoxSize: .default, serverOrigin: server,
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

    private func props(_ mediator: UIMediator) -> RootProps {
        UIProps.root(mediator.state, placement: ColumnPlacement())
    }

    private func sent(_ effects: [UIEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope } else { nil } }
    }

    // MARK: - Panels

    @Test("キャラのクリックで入力欄を開き、もう一度のクリックで閉じる")
    func clickTogglesInput() {
        var mediator = launched()
        #expect(props(mediator).input == nil)
        let opened = mediator.handle(.characterClicked)
        #expect(props(mediator).input != nil)
        #expect(opened.contains(.focusInput))
        #expect(opened.contains(.watchOutsideClicks(true)))
        let closed = mediator.handle(.characterClicked)
        #expect(props(mediator).input == nil)
        #expect(closed == [.watchOutsideClicks(false)])
    }

    @Test("Esc と、アプリの外のクリックで入力欄を閉じる。履歴は開いたまま")
    func escapeAndOutside() {
        var mediator = launched()
        _ = mediator.handle(.characterClicked)
        _ = mediator.handle(.historyOpenRequested)
        _ = mediator.handle(.inputEscaped)
        #expect(props(mediator).input == nil)
        #expect(props(mediator).history != nil)

        _ = mediator.handle(.characterClicked)
        _ = mediator.handle(.clickedOutsideApp)
        #expect(props(mediator).input == nil)
        #expect(props(mediator).history != nil)
    }

    @Test("メニューから話しかけると、閉じていても入力欄を開く。開いていれば何もしない")
    func talkOpensInput() {
        var mediator = launched()
        #expect(mediator.handle(.talkRequested).contains(.focusInput))
        #expect(mediator.handle(.talkRequested).isEmpty)
        #expect(props(mediator).input != nil)
    }

    @Test("履歴は開くときだけ前に出し、閉じる操作で閉じる")
    func history() {
        var mediator = launched()
        #expect(mediator.handle(.historyOpenRequested) == [.makeHistoryKey])
        #expect(mediator.handle(.historyButtonClicked).isEmpty)
        _ = mediator.handle(.historyCloseRequested)
        #expect(props(mediator).history == nil)
        #expect(mediator.handle(.historyLinkClicked) == [.makeHistoryKey])
        #expect(props(mediator).history != nil)
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
        #expect(props(mediator).balloon?.body == .receiving)
    }

    @Test("本文のクリックは前の返事だけを、× はすべての返事を既読にする")
    func readReplies() {
        var mediator = synced(
            messages: [Fixture.message("r1"), Fixture.message("r2")], readThrough: nil, unread: 2)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 1,
            help: "クリックで確かめて次へ")))

        let one = mediator.handle(.balloonTextClicked)
        #expect(sent(one).count == 1)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 0,
            help: "クリックで確かめて閉じる")))

        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)
    }

    @Test("閉じた「考え中」は、吹き出しの中身が変わるまで出さない")
    func dismissThinking() {
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", eventId: "e1")],
            readThrough: "m1")
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2,
            payload: Fixture.message("m2", role: "owner", kind: "message", eventId: "e2"))))
        #expect(props(mediator).balloon?.body == .thinking)

        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 3, payload: Fixture.message("r3", text: "架空の返事", replyTo: "e2"))))
        #expect(props(mediator).balloon?.body != nil)
        if case .reply = props(mediator).balloon?.body {} else { Issue.record("返事が出ていない") }
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

    @Test("知らせの本文のクリックは前のカードだけ、× はすべてを確かめる")
    func acknowledgeNotices() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        var mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(sent(mediator.handle(.noticeTextClicked)).count == 1)
        #expect(props(mediator).character.badge?.count == 1)
        #expect(sent(mediator.handle(.noticeCloseClicked)).count == 1)
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
        #expect(props(mediator).history?.rows.count == 1)
        let effects = mediator.handle(.logoutRequested)
        #expect(effects.contains(.disconnect))
        #expect(effects.contains(.logout))
        #expect(props(mediator).history?.rows.isEmpty == true)
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

    @Test("倍率と入力欄の大きさは、変わったときだけ保存する")
    func sizes() {
        var mediator = launched()
        #expect(mediator.handle(.characterScaleChanged(CharacterScale(1.5))) == [.saveCharacterScale(CharacterScale(1.5))])
        #expect(props(mediator).character.scale == CharacterScale(1.5))
        #expect(mediator.handle(.inputTextHeightMeasured(40)) == [])
        #expect(mediator.handle(.inputTextHeightMeasured(40)).isEmpty)
    }

    @Test("つまみのドラッグは、つかんだところからの差で大きさを決める")
    func grip() {
        var mediator = launched()
        _ = mediator.handle(.gripDragged(to: CGPoint(x: 100, y: 100)))
        let effects = mediator.handle(.gripDragged(to: CGPoint(x: 120, y: 80)))
        // Right widens both sides, down makes the text area taller.
        let expected = InputBoxSize(width: InputBoxSize.default.width + 40, height: InputBoxSize.default.height + 20)
        #expect(effects == [.saveInputBoxSize(expected)])
        _ = mediator.handle(.gripReleased)
        // A new drag starts from the size it has now.
        _ = mediator.handle(.gripDragged(to: CGPoint(x: 200, y: 200)))
        #expect(mediator.handle(.gripDragged(to: CGPoint(x: 210, y: 200)))
            == [.saveInputBoxSize(InputBoxSize(width: expected.width + 20, height: expected.height))])
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

    @Test("接続の状態は接続の状態機械から決まり、入力欄の案内になる")
    func status() {
        var mediator = launched()
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.connecting.text)
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        #expect(props(mediator).character.disconnectedHelp == nil)

        _ = mediator.handle(.characterClicked)
        #expect(props(mediator).input?.status == nil)

        let effects = mediator.handle(.socketClosed(.code(1008)))
        #expect(effects.contains(.clearSession))
        #expect(props(mediator).input?.status
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

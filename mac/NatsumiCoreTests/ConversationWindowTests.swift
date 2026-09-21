import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("会話のウインドウの大きさと置き場所")
struct ConversationWindowTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)

    private func defaults() -> UserDefaults {
        let name = "natsumi.tests.conversation.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func window(
        at origin: CGPoint? = CGPoint(x: 100, y: 100), width: CGFloat = 320, folded: CGFloat = 140,
        unfolded: CGFloat = 480, showsHistory: Bool = false
    ) -> ConversationWindow {
        ConversationWindow(
            origin: origin, width: width, foldedHeight: folded, unfoldedHeight: unfolded, showsHistory: showsHistory)
    }

    // MARK: - The value

    @Test("幅と 2 つの高さには下限があり、壊れた値は既定に戻す")
    func clamps() {
        #expect(window(width: 10, folded: 10, unfolded: 10) == window(width: 260, folded: 120, unfolded: 260))
        #expect(window(width: CGFloat.nan, folded: .infinity, unfolded: -.infinity) == window())
        #expect(window(at: CGPoint(x: CGFloat.nan, y: 0)).origin == nil)
        #expect(ConversationWindow.default.origin == nil)
        #expect(ConversationWindow.default.showsHistory == false)
    }

    @Test("高さは畳んでいるか開いているかで決まり、枠は置かれてから初めてある")
    func heightFollowsTheState() {
        #expect(window().height == 140)
        #expect(window(showsHistory: true).height == 480)
        #expect(window().frame == CGRect(x: 100, y: 100, width: 320, height: 140))
        #expect(window(at: nil).frame == nil)
    }

    @Test("置き直された枠は、幅と、いまの状態の高さだけを変える")
    func leftAt() {
        let folded = window().left(at: CGRect(x: 50, y: 60, width: 400, height: 200))
        #expect(folded == window(at: CGPoint(x: 50, y: 60), width: 400, folded: 200))
        let unfolded = window(showsHistory: true).left(at: CGRect(x: 50, y: 60, width: 400, height: 600))
        #expect(unfolded == window(at: CGPoint(x: 50, y: 60), width: 400, unfolded: 600, showsHistory: true))
    }

    // MARK: - Opening and closing the history

    @Test("開くときは上下に均等に伸び、畳むときは上下に均等に縮む")
    func growsEvenly() {
        let folded = window(at: CGPoint(x: 100, y: 330))
        let unfolded = folded.togglingHistory(within: screen)
        #expect(unfolded.showsHistory)
        // The middle was at 400; 480 tall about it is 160...640.
        #expect(unfolded.frame == CGRect(x: 100, y: 160, width: 320, height: 480))
        let back = unfolded.togglingHistory(within: screen)
        #expect(back == folded)
    }

    @Test("片側に余裕が無ければ、足りない分だけ余裕のある側に余計に伸びる")
    func spillsToTheSideWithRoom() {
        let low = window(at: CGPoint(x: 100, y: 0)).togglingHistory(within: screen)
        #expect(low.frame == CGRect(x: 100, y: 0, width: 320, height: 480))
        let high = window(at: CGPoint(x: 100, y: 660)).togglingHistory(within: screen)
        #expect(high.frame == CGRect(x: 100, y: 320, width: 320, height: 480))
    }

    @Test("開いたあと動かしていなければ、畳むときは開く前の場所に戻る（片側にはみ出して伸びた分も戻す）")
    func foldsBackToWhereItWas() {
        let folded = window(at: CGPoint(x: 100, y: 0))
        let unfolded = folded.togglingHistory(within: screen)
        #expect(unfolded.frame?.midY != folded.frame?.midY)
        #expect(unfolded.togglingHistory(within: screen) == folded)
    }

    @Test("開いたあと動かしたり大きさを変えたりしていれば、畳むときはその場で上下に均等に縮む")
    func foldsAboutTheMiddleOnceMoved() {
        let unfolded = window(at: CGPoint(x: 100, y: 0)).togglingHistory(within: screen)
        let moved = unfolded.left(at: CGRect(x: 300, y: 200, width: 320, height: 480))
        let back = moved.togglingHistory(within: screen)
        #expect(back.frame == CGRect(x: 300, y: 370, width: 320, height: 140))
        #expect(back.foldedOrigin == nil)
        #expect(back.unfoldedFrame == nil)
        let resized = unfolded.left(at: CGRect(x: 100, y: 0, width: 320, height: 600))
        #expect(resized.togglingHistory(within: screen).frame == CGRect(x: 100, y: 230, width: 320, height: 140))
    }

    @Test("開く前の場所が画面から出ていれば、戻すときに画面に入れる")
    func foldsBackOntoTheScreen() {
        let unfolded = window(at: CGPoint(x: 100, y: 0)).togglingHistory(within: screen)
        let smaller = CGRect(x: 0, y: 100, width: 1000, height: 700)
        #expect(unfolded.togglingHistory(within: smaller).frame == CGRect(x: 100, y: 100, width: 320, height: 140))
    }

    @Test("両側とも足りなければ、見える範囲いっぱいにする")
    func fillsAShortScreen() {
        let short = CGRect(x: 0, y: 50, width: 1000, height: 300)
        let grown = ConversationPlacement.grown(
            CGRect(x: 100, y: 100, width: 320, height: 140), to: 480, within: short)
        #expect(grown == CGRect(x: 100, y: 50, width: 320, height: 300))
    }

    @Test("まだ置かれていないウインドウは、開閉しても位置を持たない")
    func togglingBeforePlacing() {
        let toggled = window(at: nil).togglingHistory(within: screen)
        #expect(toggled.showsHistory)
        #expect(toggled.origin == nil)
    }

    @Test("初回はキャラクターの真下に、横の中心をそろえて置く。画面からはみ出す分は中に入れる")
    func firstUnderTheCharacter() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let size = CGSize(width: 320, height: 140)
        #expect(ConversationPlacement.first(under: character, size: size, spacing: 8, visible: screen)
            == CGRect(x: 290, y: 300 - 8 - 140, width: 320, height: 140))
        let low = CGRect(x: 950, y: 0, width: 100, height: 100)
        #expect(ConversationPlacement.first(under: low, size: size, spacing: 8, visible: screen)
            == CGRect(x: 680, y: 0, width: 320, height: 140))
    }

    // MARK: - The settings

    @Test("保存がなければ既定、保存したウインドウは次に読んでも残る")
    func persists() {
        let store = defaults()
        let settings = OverlaySettings(defaults: store)
        #expect(settings.conversationWindow == .default)
        var left = window(at: CGPoint(x: 12.5, y: 34), width: 400, folded: 150, unfolded: 700, showsHistory: true)
        left.foldedOrigin = CGPoint(x: 12.5, y: 300)
        left.unfoldedFrame = CGRect(x: 12.5, y: 34, width: 400, height: 700)
        settings.conversationWindow = left
        #expect(OverlaySettings(defaults: store).conversationWindow == left)
        settings.conversationWindow = window(at: nil)
        #expect(OverlaySettings(defaults: store).conversationWindow.origin == nil)
    }

    @Test("壊れた保存値は既定に戻す")
    func invalidStoredValue() {
        let store = defaults()
        store.set("大きい", forKey: OverlaySettings.conversationWindowKey)
        #expect(OverlaySettings(defaults: store).conversationWindow == .default)
        store.set(["width": "wide"], forKey: OverlaySettings.conversationWindowKey)
        #expect(OverlaySettings(defaults: store).conversationWindow == ConversationWindow(
            origin: nil, width: .nan, foldedHeight: .nan, unfoldedHeight: .nan, showsHistory: false))
    }

    @Test("以前の入力欄の大きさは、幅と畳んだ高さとして初回だけ読み替える")
    func legacyInputBoxSize() {
        let store = defaults()
        store.set([400.0, 100.0], forKey: OverlaySettings.legacyInputBoxSizeKey)
        let settings = OverlaySettings(defaults: store)
        #expect(settings.conversationWindow == ConversationWindow(
            origin: nil, width: 400, foldedHeight: 100 + OverlaySettings.legacyChrome,
            unfoldedHeight: ConversationWindow.default.unfoldedHeight, showsHistory: false))
        settings.conversationWindow = window(width: 300)
        #expect(OverlaySettings(defaults: store).conversationWindow == window(width: 300))
    }

    @Test("一列の幅は設定の数として残り、無ければ以前の入力欄の幅、それも無ければ既定")
    func columnWidth() {
        let store = defaults()
        let settings = OverlaySettings(defaults: store)
        #expect(settings.columnWidth == 280)
        store.set([400.0, 100.0], forKey: OverlaySettings.legacyInputBoxSizeKey)
        #expect(settings.columnWidth == 400)
        settings.columnWidth = 500
        #expect(OverlaySettings(defaults: store).columnWidth == 500)
        settings.columnWidth = 5000
        #expect(OverlaySettings(defaults: store).columnWidth == 640)
    }
}

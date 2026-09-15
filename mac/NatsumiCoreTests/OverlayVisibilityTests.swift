import Testing
@testable import NatsumiCore

@Suite("入力欄と履歴の開閉")
struct OverlayVisibilityTests {
    @Test("キャラのクリックで入力欄を開き、もう一度のクリックで閉じる")
    func clickToggles() {
        var visibility = OverlayVisibility()
        #expect(visibility.isInputOpen == false)
        visibility.characterClicked()
        #expect(visibility.isInputOpen)
        visibility.characterClicked()
        #expect(visibility.isInputOpen == false)
    }

    @Test("Esc と、アプリの外のクリックで入力欄を閉じる。履歴は開いたまま")
    func escapeAndOutside() {
        var visibility = OverlayVisibility()
        visibility.characterClicked()
        visibility.openHistory()
        visibility.escape()
        #expect(visibility.isInputOpen == false)
        #expect(visibility.isHistoryOpen)

        visibility.characterClicked()
        visibility.clickedOutside()
        #expect(visibility.isInputOpen == false)
        #expect(visibility.isHistoryOpen)
    }

    @Test("履歴は開く・閉じる・切り替えができる")
    func history() {
        var visibility = OverlayVisibility()
        visibility.toggleHistory()
        #expect(visibility.isHistoryOpen)
        visibility.toggleHistory()
        #expect(visibility.isHistoryOpen == false)
        visibility.openHistory()
        visibility.closeHistory()
        #expect(visibility.isHistoryOpen == false)
    }

    @Test("メニューから話しかけると、閉じていても入力欄を開く")
    func openInput() {
        var visibility = OverlayVisibility()
        visibility.openInput()
        visibility.openInput()
        #expect(visibility.isInputOpen)
    }
}

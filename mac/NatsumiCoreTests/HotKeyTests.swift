import Foundation
import Testing
@testable import NatsumiCore

@Suite("会話のウインドウを出すグローバルなショートカット")
struct HotKeyTests {
    private func defaults() -> UserDefaults {
        let name = "natsumi.tests.hotkey.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("既定は ⌃⌥N。⌘⇧N は Finder・ブラウザ・Xcode のショートカットとぶつかる")
    func defaultKey() {
        #expect(HotKey.default == HotKey(keyCode: HotKey.KeyCode.n, modifiers: [.control, .option]))
        #expect(HotKey.default.displayName == "⌃⌥N")
    }

    @Test("修飾キーは ⌃⌥⇧⌘ の順に並べ、キーは配列の名前で出す")
    func displayName() {
        #expect(HotKey(keyCode: HotKey.KeyCode.n, modifiers: [.command, .shift]).displayName == "⇧⌘N")
        #expect(HotKey(keyCode: 49, modifiers: [.command, .control, .option, .shift]).displayName == "⌃⌥⇧⌘Space")
        #expect(HotKey(keyCode: 18, modifiers: [.option]).displayName == "⌥1")
        #expect(HotKey(keyCode: 122, modifiers: [.control]).displayName == "⌃F1")
        #expect(HotKey(keyCode: 126, modifiers: [.command]).displayName == "⌘↑")
        #expect(HotKey(keyCode: 250, modifiers: [.command]).displayName == "⌘Key250")
    }

    @Test("⌘・⌃・⌥ のどれかが要る。Shift だけ・修飾なし・修飾キーそのものは使えない")
    func usable() {
        #expect(HotKey.default.isUsable)
        #expect(HotKey(keyCode: HotKey.KeyCode.n, modifiers: [.command]).isUsable)
        #expect(!HotKey(keyCode: HotKey.KeyCode.n, modifiers: []).isUsable)
        #expect(!HotKey(keyCode: HotKey.KeyCode.n, modifiers: [.shift]).isUsable)
        // The Command key itself, reported as a key.
        #expect(!HotKey(keyCode: 55, modifiers: [.command]).isUsable)
        // F-keys stand on their own, with or without a modifier.
        #expect(HotKey(keyCode: 122, modifiers: []).isUsable)
    }

    @Test("保存していなければ既定、保存すればそれ、「なし」にすればなし")
    func saved() {
        let settings = OverlaySettings(defaults: defaults())
        #expect(settings.hotKey == .default)
        let key = HotKey(keyCode: 49, modifiers: [.command, .option])
        settings.hotKey = key
        #expect(settings.hotKey == key)
        settings.hotKey = nil
        #expect(settings.hotKey == nil)
    }

    @Test("壊れた保存値は既定に戻す")
    func broken() {
        let defaults = defaults()
        defaults.set(["keyCode": "N"], forKey: OverlaySettings.hotKeyKey)
        #expect(OverlaySettings(defaults: defaults).hotKey == .default)
        defaults.set(["keyCode": 45, "modifiers": 0], forKey: OverlaySettings.hotKeyKey)
        #expect(OverlaySettings(defaults: defaults).hotKey == .default)
    }
}

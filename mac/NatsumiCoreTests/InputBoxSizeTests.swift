import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("入力欄の大きさ")
struct InputBoxSizeTests {
    private func defaults() -> UserDefaults {
        let name = "natsumi.tests.input.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("幅は 200〜640、文字の欄の高さの上限は 40〜400 に収める")
    func clamps() {
        #expect(InputBoxSize(width: 300, height: 120) == InputBoxSize(width: 300, height: 120))
        #expect(InputBoxSize(width: 10, height: 10) == InputBoxSize(width: 200, height: 40))
        #expect(InputBoxSize(width: 9000, height: 9000) == InputBoxSize(width: 640, height: 400))
        #expect(InputBoxSize(width: .nan, height: .infinity) == .default)
        #expect(InputBoxSize.default == InputBoxSize(width: 280, height: 40))
    }

    @Test("文字の欄は選んだ高さを下限に行に合わせて伸び、160 か選んだ高さの大きい方で止まって中でスクロールする")
    func textHeight() {
        let size = InputBoxSize(width: 280, height: 60)
        #expect(size.textHeight(content: 10, minimum: 22) == 60)
        #expect(size.textHeight(content: 100, minimum: 22) == 100)
        #expect(size.textHeight(content: 300, minimum: 22) == 160)
        #expect(InputBoxSize(width: 280, height: 300).textHeight(content: 350, minimum: 22) == 300)
        #expect(InputBoxSize(width: 280, height: 40).textHeight(content: 10, minimum: 44) == 44)
    }

    @Test("保存がなければ既定、保存した大きさは次に読んでも残り、キャラの倍率とは別に持つ")
    func persists() {
        let store = defaults()
        var settings = OverlaySettings(defaults: store)
        #expect(settings.inputBoxSize == .default)
        settings.inputBoxSize = InputBoxSize(width: 400, height: 200)
        settings.characterScale = CharacterScale(2)
        #expect(OverlaySettings(defaults: store).inputBoxSize == InputBoxSize(width: 400, height: 200))
        settings.characterScale = CharacterScale(0.5)
        #expect(OverlaySettings(defaults: store).inputBoxSize == InputBoxSize(width: 400, height: 200))
    }

    @Test("範囲外の保存値は範囲に収め、壊れた値は既定に戻す")
    func invalidStoredValue() {
        let store = defaults()
        store.set([5000.0, 1.0], forKey: OverlaySettings.inputBoxSizeKey)
        #expect(OverlaySettings(defaults: store).inputBoxSize == InputBoxSize(width: 640, height: 40))
        store.set("大きい", forKey: OverlaySettings.inputBoxSizeKey)
        #expect(OverlaySettings(defaults: store).inputBoxSize == .default)
    }
}

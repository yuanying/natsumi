import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("キャラの倍率")
struct CharacterScaleTests {
    private func defaults() -> UserDefaults {
        let name = "natsumi.tests.scale.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("範囲は 50% から 200% で、25% 刻みに丸める")
    func clampsAndRounds() {
        #expect(CharacterScale(1).value == 1)
        #expect(CharacterScale(0.1).value == 0.5)
        #expect(CharacterScale(9).value == 2)
        #expect(CharacterScale(1.3).value == 1.25)
        #expect(CharacterScale(1.4).value == 1.5)
        #expect(CharacterScale(.nan).value == 1)
        #expect(CharacterScale(.infinity).value == 1)
        #expect(CharacterScale(1.5).percent == 150)
    }

    @Test("絵の大きさは spritesheet の 1 マス（2x のピクセル）の半分に倍率を掛けたもの")
    func artSize() {
        #expect(CharacterScale(1).artSize == CGSize(width: 96, height: 104))
        #expect(CharacterScale(2).artSize == CGSize(width: 192, height: 208))
        #expect(CharacterScale(0.5).artSize == CGSize(width: 48, height: 52))
    }

    @Test("文字の倍率は読める範囲に抑える")
    func textScale() {
        #expect(CharacterScale(0.5).textScale == 0.85)
        #expect(CharacterScale(1).textScale == 1)
        #expect(CharacterScale(1.25).textScale == 1.25)
        #expect(CharacterScale(2).textScale == 1.4)
    }

    @Test("保存がなければ 100%、保存した値は次に読んでも残る")
    func persists() {
        let store = defaults()
        #expect(OverlaySettings(defaults: store).characterScale == .default)
        var settings = OverlaySettings(defaults: store)
        settings.characterScale = CharacterScale(1.75)
        #expect(OverlaySettings(defaults: store).characterScale.value == 1.75)
    }

    @Test("範囲外や壊れた保存値は、範囲に収めるか既定に戻す")
    func invalidStoredValue() {
        let store = defaults()
        store.set(5.0, forKey: OverlaySettings.characterScaleKey)
        #expect(OverlaySettings(defaults: store).characterScale.value == 2)
        store.set("大きい", forKey: OverlaySettings.characterScaleKey)
        #expect(OverlaySettings(defaults: store).characterScale == .default)
    }
}

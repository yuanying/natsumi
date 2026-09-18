import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("キャラクターの居場所と、走っての移動")
struct CharacterPlaceTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let character = CGRect(x: 400, y: 300, width: 100, height: 100)

    private func mediator(at frame: CGRect? = nil, visible: CGRect? = nil) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, inputBoxSize: .default, serverOrigin: nil,
            avatarDirectory: "/tmp/avatar", defaultAvatarDirectory: "/tmp/avatar")))
        _ = mediator.handle(.characterFrameChanged(frame ?? character, visible: visible ?? screen))
        return mediator
    }

    private func moves(_ effects: [UIEffect]) -> [CGPoint] {
        effects.compactMap { if case .moveCharacter(let to) = $0 { to } else { nil } }
    }

    // MARK: - Which way she faces

    @Test("走る向きは横の動きで決まり、ほぼ真上・真下のときは直前の向きを保つ")
    func facing() {
        let here = CGPoint(x: 100, y: 100)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 300, y: 100), keeping: .left) == .right)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 10, y: 400), keeping: .right) == .left)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 100, y: 400), keeping: .left) == .left)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 100, y: 400), keeping: .right) == .right)
    }

    // MARK: - The owner's drag

    @Test("ドラッグの間は進む向きの走る絵にし、手を離したら止まって定位置を覚える")
    func drag() {
        var mediator = self.mediator()
        _ = mediator.handle(.characterDragBegan)
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: 60, dy: 20), visible: screen))
        #expect(mediator.state.motion == .running(.right))
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: -40, dy: 20), visible: screen))
        #expect(mediator.state.motion == .running(.left))

        let ended = mediator.handle(.characterDragEnded)
        #expect(mediator.state.motion == .still)
        #expect(ended.contains(.saveCharacterPlace))
    }

    @Test("ドラッグの間は、ポインタを見張らない")
    func noDodgeWhileDragging() {
        var mediator = self.mediator()
        #expect(mediator.handle(.characterDragBegan).contains(.watchPointer(near: nil)))
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))).isEmpty)
        #expect(mediator.handle(.characterDragEnded).contains(.watchPointer(near: character)))
    }

    // MARK: - The screens

    @Test("画面の構成が変わったら、画面の中へ走って戻る")
    func backOntoTheScreen() {
        var mediator = self.mediator(at: CGRect(x: 1400, y: 300, width: 100, height: 100))
        let smaller = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let effects = mediator.handle(.screenConfigurationChanged(visible: smaller))
        #expect(moves(effects) == [CGPoint(x: 900, y: 300)])
        #expect(mediator.state.motion == .running(.left))

        _ = mediator.handle(.characterFrameChanged(CGRect(x: 900, y: 300, width: 100, height: 100), visible: smaller))
        let finished = mediator.handle(.characterMoveFinished)
        #expect(mediator.state.motion == .still)
        #expect(finished.contains(.saveCharacterPlace))
    }

    @Test("画面の中にいるなら、画面の構成が変わっても動かさない")
    func staysWhenAlreadyOnScreen() {
        var mediator = self.mediator()
        #expect(moves(mediator.handle(.screenConfigurationChanged(visible: screen))).isEmpty)
    }

    // MARK: - Room for the column

    @Test("一列が入らないと知らせが来たら、そのぶん走って場所を空ける")
    func makesRoomForTheColumn() {
        var mediator = self.mediator()
        let effects = mediator.handle(.columnNeedsRoom(offset: -80))
        #expect(moves(effects) == [CGPoint(x: 400, y: 220)])
        // Moving straight down keeps the way she was facing.
        #expect(mediator.state.motion == .running(.right))
    }

    @Test("ドラッグしている間は、一列のために動かない")
    func noRoomWhileDragging() {
        var mediator = self.mediator()
        _ = mediator.handle(.characterDragBegan)
        #expect(moves(mediator.handle(.columnNeedsRoom(offset: -80))).isEmpty)
    }

    // MARK: - Getting out of the pointer's way

    @Test("ポインタが近づいたら画面の端へ走ってどき、離れたら元の場所へ走って戻る")
    func dodge() {
        var mediator = self.mediator()
        let away = mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))
        #expect(moves(away) == [CGPoint(x: 900, y: 300)])
        #expect(mediator.state.motion == .running(.right))
        // While she is out of the way, the pointer is watched around the place she comes back to, so that she does
        // not set off again as soon as she lands.
        #expect(mediator.state.watchedPointerRect == character)
        // Her own place is not overwritten while she is away.
        #expect(mediator.handle(.characterMoveFinished).contains(.saveCharacterPlace) == false)

        _ = mediator.handle(.characterFrameChanged(CGRect(x: 900, y: 300, width: 100, height: 100), visible: screen))
        let back = mediator.handle(.pointerWentAway)
        #expect(moves(back) == [character.origin])
        #expect(mediator.state.motion == .running(.left))
    }

    @Test("入力欄が開いている間は、ポインタを見張らずにどかない")
    func noDodgeWhileTheInputIsOpen() {
        var mediator = self.mediator()
        #expect(mediator.handle(.characterClicked).contains(.watchPointer(near: nil)))
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))).isEmpty)
        #expect(mediator.handle(.characterClicked).contains(.watchPointer(near: character)))
    }

    @Test("どく先がポインタから十分に離れないときは、どかない")
    func noRoomToDodge() {
        let narrow = CGRect(x: 0, y: 0, width: 200, height: 800)
        var mediator = self.mediator(at: CGRect(x: 50, y: 300, width: 100, height: 100), visible: narrow)
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 100, y: 350)))).isEmpty)
    }

    // MARK: - Where she goes

    @Test("どく先は画面の端。すでに端にいるなら、端に沿ってポインタから遠ざかる")
    func dodgeTarget() {
        #expect(PointerDodge.target(character: character, pointer: CGPoint(x: 450, y: 350), visible: screen)
            == CGPoint(x: 900, y: 300))
        #expect(PointerDodge.target(character: character, pointer: CGPoint(x: 700, y: 350), visible: screen)
            == CGPoint(x: 0, y: 300))

        let atLeftEdge = CGRect(x: 0, y: 300, width: 100, height: 100)
        #expect(PointerDodge.target(character: atLeftEdge, pointer: CGPoint(x: 50, y: 250), visible: screen)
            == CGPoint(x: 0, y: 700))
        #expect(PointerDodge.target(character: atLeftEdge, pointer: CGPoint(x: 50, y: 600), visible: screen)
            == CGPoint(x: 0, y: 0))
    }

    @Test("近い・離れたの境は別にし、戻ってすぐまた逃げることのないようにする")
    func hysteresis() {
        #expect(PointerDodge.awayMargin > PointerDodge.margin)
        #expect(PointerDodge.isNear(CGPoint(x: 510, y: 350), of: character, textScale: 1))
        #expect(PointerDodge.isNear(CGPoint(x: 560, y: 350), of: character, textScale: 1) == false)
        // The same point is not yet "away": she stays where she is until the pointer is well clear.
        #expect(PointerDodge.isAway(CGPoint(x: 560, y: 350), of: character, textScale: 1) == false)
        #expect(PointerDodge.isAway(CGPoint(x: 700, y: 350), of: character, textScale: 1))
    }
}

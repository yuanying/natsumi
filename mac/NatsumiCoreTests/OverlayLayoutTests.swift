import CoreGraphics
import Testing
@testable import NatsumiCore

@Suite("キャラと会話の表示の配置")
struct OverlayLayoutTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let balloon = CGSize(width: 200, height: 80)
    private let input = CGSize(width: 240, height: 40)
    private let history = CGSize(width: 300, height: 400)
    private let gap = OverlayLayout.gap

    @Test("吹き出しはキャラの上、入力欄は下に、キャラの中心にそろえて置く")
    func aroundCharacter() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = OverlayLayout.make(visible: screen, character: character, balloon: balloon, input: input, history: nil)
        #expect(layout.balloon == CGRect(x: 350, y: 400 + gap, width: 200, height: 80))
        #expect(layout.tail == .down)
        #expect(layout.tailX == 100)
        #expect(layout.input == CGRect(x: 330, y: 300 - gap - 40, width: 240, height: 40))
        #expect(layout.history == nil)
    }

    @Test("画面の左右の端では、はみ出さないようにずらし、しっぽはキャラを指したままにする")
    func horizontalEdges() {
        let left = OverlayLayout.make(
            visible: screen, character: CGRect(x: 0, y: 300, width: 100, height: 100), balloon: balloon, input: input, history: nil)
        #expect(left.balloon?.minX == 0)
        #expect(left.input?.minX == 0)
        #expect(left.tailX == 50)

        let right = OverlayLayout.make(
            visible: screen, character: CGRect(x: 990, y: 300, width: 10, height: 100), balloon: balloon, input: input, history: nil)
        #expect(right.balloon?.maxX == 1000)
        #expect(right.input?.maxX == 1000)
        #expect(right.tailX == 200 - OverlayLayout.tailInset)
    }

    @Test("上に入らなければ吹き出しはキャラの下に回り、しっぽは上を向く")
    func topEdge() {
        let character = CGRect(x: 400, y: 680, width: 100, height: 100)
        let layout = OverlayLayout.make(visible: screen, character: character, balloon: balloon, input: input, history: nil)
        #expect(layout.tail == .up)
        #expect(layout.input == CGRect(x: 330, y: 680 - gap - 40, width: 240, height: 40))
        #expect(layout.balloon == CGRect(x: 350, y: 680 - gap - 40 - gap - 80, width: 200, height: 80))
    }

    @Test("下に入らなければ入力欄はキャラの上に回り、吹き出しはその上に積む")
    func bottomEdge() {
        let character = CGRect(x: 400, y: 10, width: 100, height: 100)
        let layout = OverlayLayout.make(visible: screen, character: character, balloon: balloon, input: input, history: nil)
        #expect(layout.input == CGRect(x: 330, y: 110 + gap, width: 240, height: 40))
        #expect(layout.balloon == CGRect(x: 350, y: 110 + gap + 40 + gap, width: 200, height: 80))
        #expect(layout.tail == .down)
    }

    @Test("入力欄を閉じていれば、吹き出しはキャラのすぐ上に置く")
    func withoutInput() {
        let character = CGRect(x: 400, y: 10, width: 100, height: 100)
        let layout = OverlayLayout.make(visible: screen, character: character, balloon: balloon, input: nil, history: nil)
        #expect(layout.input == nil)
        #expect(layout.balloon?.minY == 110 + gap)
    }

    @Test("履歴はキャラの横の、入る側に、上端をそろえて置く")
    func historyBeside() {
        let right = OverlayLayout.make(
            visible: screen, character: CGRect(x: 800, y: 300, width: 100, height: 100), balloon: nil, input: nil, history: history)
        #expect(right.history == CGRect(x: 800 - gap - 300, y: 0, width: 300, height: 400))

        let left = OverlayLayout.make(
            visible: screen, character: CGRect(x: 100, y: 500, width: 100, height: 100), balloon: nil, input: nil, history: history)
        #expect(left.history == CGRect(x: 200 + gap, y: 200, width: 300, height: 400))
    }

    @Test("大きさを変えるとき、足もと（下端の中心）を動かさず、画面に収める")
    func resize() {
        let frame = CGRect(x: 400, y: 300, width: 96, height: 104)
        #expect(OverlayLayout.resized(frame, to: CGSize(width: 192, height: 208), within: screen)
            == CGRect(x: 352, y: 300, width: 192, height: 208))
        #expect(OverlayLayout.resized(CGRect(x: 950, y: 700, width: 48, height: 52), to: CGSize(width: 192, height: 208), within: screen)
            == CGRect(x: 808, y: 592, width: 192, height: 208))
    }

    @Test("画面の外に出たキャラは画面の中に戻す")
    func clampCharacter() {
        #expect(OverlayLayout.clamp(CGRect(x: -50, y: 900, width: 100, height: 100), into: screen)
            == CGRect(x: 0, y: 700, width: 100, height: 100))
        #expect(OverlayLayout.clamp(CGRect(x: 10, y: 10, width: 100, height: 100), into: screen)
            == CGRect(x: 10, y: 10, width: 100, height: 100))
    }
}

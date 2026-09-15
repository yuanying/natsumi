import CoreGraphics
import Testing
@testable import NatsumiCore

@Suite("キャラと会話の表示の配置（縦に一列）")
struct OverlayLayoutTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let spacing: CGFloat = 8
    private let notices = CGSize(width: 200, height: 60)
    private let balloon = CGSize(width: 240, height: 80)
    private let input = CGSize(width: 280, height: 40)
    private let history = CGSize(width: 300, height: 400)

    private func make(
        _ character: CGRect, notices: CGSize? = nil, balloon: CGSize? = nil, input: CGSize? = nil, history: CGSize? = nil,
        visible: CGRect? = nil
    ) -> OverlayLayout {
        OverlayLayout.make(
            visible: visible ?? screen, character: character, spacing: spacing,
            notices: notices, balloon: balloon, input: input, history: history)
    }

    @Test("上から知らせ・吹き出し・キャラ・入力欄の順に、キャラの中心の縦の線にそろえ、間隔を一定にする")
    func column() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = make(character, notices: notices, balloon: balloon, input: input)
        #expect(layout.balloon == CGRect(x: 330, y: 400 + spacing, width: 240, height: 80))
        #expect(layout.notices == CGRect(x: 350, y: 400 + spacing + 80 + spacing, width: 200, height: 60))
        #expect(layout.input == CGRect(x: 310, y: 300 - spacing - 40, width: 280, height: 40))
        #expect(layout.isFlipped == false)
        #expect(layout.tail == .down)
        #expect(layout.tailX == 120)
        #expect(layout.overflow == 0)
        for rect in [layout.notices, layout.balloon, layout.input] { #expect(rect?.midX == character.midX) }
    }

    @Test("返事が無ければ、知らせの束はキャラのすぐ上に置く")
    func noticesWithoutBalloon() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = make(character, notices: notices)
        #expect(layout.notices == CGRect(x: 350, y: 400 + spacing, width: 200, height: 60))
        #expect(layout.balloon == nil)
    }

    @Test("上に足りなければ一列を上下に反転し、キャラの下に吹き出しと知らせ、上に入力欄を置く。しっぽは上を指す")
    func flipAtTop() {
        let character = CGRect(x: 400, y: 600, width: 100, height: 100)
        let layout = make(character, notices: notices, balloon: balloon, input: input)
        #expect(layout.isFlipped)
        #expect(layout.tail == .up)
        #expect(layout.balloon == CGRect(x: 330, y: 600 - spacing - 80, width: 240, height: 80))
        #expect(layout.notices == CGRect(x: 350, y: 600 - spacing - 80 - spacing - 60, width: 200, height: 60))
        #expect(layout.input == CGRect(x: 310, y: 700 + spacing, width: 280, height: 40))
    }

    @Test("入力欄が反対側に入らなければ、キャラと吹き出しの間に入れる")
    func inputBetweenAtBottom() {
        let character = CGRect(x: 400, y: 10, width: 100, height: 100)
        let layout = make(character, notices: notices, balloon: balloon, input: input)
        #expect(layout.isFlipped == false)
        #expect(layout.tail == .down)
        #expect(layout.input == CGRect(x: 310, y: 110 + spacing, width: 280, height: 40))
        #expect(layout.balloon == CGRect(x: 330, y: 110 + spacing + 40 + spacing, width: 240, height: 80))
        #expect(layout.notices?.minY == layout.balloon!.maxY + spacing)
    }

    @Test("横にはみ出すパネルだけを内側にずらし、しっぽはキャラの中心を指し続ける")
    func shiftAtSides() {
        let left = make(CGRect(x: 0, y: 300, width: 100, height: 100), notices: notices, balloon: balloon, input: input)
        #expect(left.balloon?.minX == 0)
        #expect(left.input?.minX == 0)
        #expect(left.notices?.minX == 0)
        #expect(left.tailX == 50)

        let right = make(CGRect(x: 900, y: 300, width: 100, height: 100), notices: notices, balloon: balloon, input: input)
        #expect(right.balloon?.maxX == 1000)
        #expect(right.input?.maxX == 1000)
        #expect(right.tailX == CGFloat(950 - 760))

        let edge = make(CGRect(x: 990, y: 300, width: 10, height: 100), balloon: balloon)
        #expect(edge.tailX == 240 - OverlayLayout.tailInset)
    }

    @Test("どの状態でも、パネルは画面の中に入り、キャラにも互いにも重ならない")
    func invariants() {
        let places: [(String, (CGSize) -> CGPoint)] = [
            ("左下", { _ in CGPoint(x: 0, y: 0) }),
            ("右下", { s in CGPoint(x: 1000 - s.width, y: 0) }),
            ("左上", { s in CGPoint(x: 0, y: 800 - s.height) }),
            ("右上", { s in CGPoint(x: 1000 - s.width, y: 800 - s.height) }),
            ("中央", { s in CGPoint(x: 500 - s.width / 2, y: 400 - s.height / 2) }),
        ]
        let options: [CGSize?] = [nil]
        for scale in [0.5, 1, 2] {
            let art = CharacterScale(scale).artSize
            for (name, origin) in places {
                let character = CGRect(origin: origin(art), size: art)
                for n in options + [notices] {
                    for b in options + [balloon] {
                        for i in options + [input] {
                            let layout = make(character, notices: n, balloon: b, input: i)
                            let rects = [layout.notices, layout.balloon, layout.input].compactMap { $0 }
                            #expect(layout.overflow == 0, "\(name) \(scale)")
                            for (index, rect) in rects.enumerated() {
                                #expect(screen.contains(rect), "\(name) \(scale) \(rect)")
                                #expect(rect.intersects(character) == false, "\(name) \(scale) \(rect)")
                                for other in rects[(index + 1)...] { #expect(rect.intersects(other) == false, "\(name) \(scale)") }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test("キャラの枠は、大きさが変わらない限り、画面の外にかかっていてもそのまま（瞬間移動しない）")
    func characterStays() {
        let corner = CGRect(x: 960, y: -20, width: 96, height: 104)
        #expect(OverlayLayout.characterFrame(corner, art: CGSize(width: 96, height: 104), visible: screen) == corner)
        let center = CGRect(x: 400, y: 300, width: 96, height: 104)
        #expect(OverlayLayout.characterFrame(center, art: CGSize(width: 96, height: 104), visible: screen) == center)
        // A new size keeps the feet in place and brings the character onto the screen.
        #expect(OverlayLayout.characterFrame(center, art: CGSize(width: 192, height: 208), visible: screen)
            == CGRect(x: 352, y: 300, width: 192, height: 208))
    }

    @Test("高さが足りなければ、後ろに見せる枚数を減らし、それでも足りなければ吹き出しの行数を減らす")
    func shrinkWhenShort() {
        let short = CGRect(x: 0, y: 0, width: 1000, height: 300)
        let character = CGRect(x: 400, y: 100, width: 100, height: 100)
        var asked: [StackBudget] = []
        let layout = OverlayLayout.fit(visible: short, character: character, spacing: spacing, input: nil, history: nil) { budget in
            asked.append(budget)
            let edges = CGFloat(budget.behind) * 5
            return (notices: CGSize(width: 200, height: 20 + edges), balloon: CGSize(width: 240, height: 12 * CGFloat(budget.lines) + 10 + edges))
        }
        // Above and below there are 100 points: 20+8 + 34+8 fits only with two lines and no edges.
        #expect(asked == Array(StackBudget.steps.prefix(3)))
        #expect(layout.budget == StackBudget(behind: 0, lines: 2))
        #expect(layout.overflow == 0)
        #expect(short.contains(layout.balloon!))
        #expect(short.contains(layout.notices!))
    }

    @Test("履歴は一列に入れず、一列の横の空いている側に、一列のパネルと重ならないように開く")
    func historyBeside() {
        let center = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = make(center, notices: notices, balloon: balloon, input: input, history: history)
        let placed = try! #require(layout.history)
        for rect in [layout.notices, layout.balloon, layout.input, center].compactMap({ $0 }) {
            #expect(placed.intersects(rect) == false)
        }
        #expect(screen.contains(placed))

        let right = make(CGRect(x: 880, y: 300, width: 100, height: 100), balloon: balloon, input: input, history: history)
        let left = try! #require(right.history)
        #expect(left.maxX <= right.input!.minX)
        #expect(screen.contains(left))
    }

    @Test("画面の外に出たキャラは画面の中に戻す")
    func clampCharacter() {
        #expect(OverlayLayout.clamp(CGRect(x: -50, y: 900, width: 100, height: 100), into: screen)
            == CGRect(x: 0, y: 700, width: 100, height: 100))
        #expect(OverlayLayout.clamp(CGRect(x: 10, y: 10, width: 100, height: 100), into: screen)
            == CGRect(x: 10, y: 10, width: 100, height: 100))
    }

    @Test("間隔はキャラの倍率に合わせる")
    func spacingScales() {
        #expect(OverlayLayout.spacing(for: CharacterScale(1)) == 8)
        #expect(OverlayLayout.spacing(for: CharacterScale(0.5)) < OverlayLayout.spacing(for: CharacterScale(2)))
    }
}

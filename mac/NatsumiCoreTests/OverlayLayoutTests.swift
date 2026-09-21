import CoreGraphics
import Testing
@testable import NatsumiCore

@Suite("キャラと会話の表示の配置（縦に一列）")
struct OverlayLayoutTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let spacing: CGFloat = 8
    private let notices = CGSize(width: 200, height: 60)
    private let balloon = CGSize(width: 240, height: 80)

    private func make(
        _ character: CGRect, notices: CGSize? = nil, balloon: CGSize? = nil, visible: CGRect? = nil
    ) -> OverlayLayout {
        OverlayLayout.make(visible: visible ?? screen, character: character, spacing: spacing, notices: notices, balloon: balloon)
    }

    @Test("上から知らせ・吹き出し・キャラの順に、キャラの中心の縦の線にそろえ、間隔を一定にする")
    func column() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = make(character, notices: notices, balloon: balloon)
        #expect(layout.balloon == CGRect(x: 330, y: 400 + spacing, width: 240, height: 80))
        #expect(layout.notices == CGRect(x: 350, y: 400 + spacing + 80 + spacing, width: 200, height: 60))
        #expect(layout.isFlipped == false)
        #expect(layout.tail == .down)
        #expect(layout.tailX == 120)
        #expect(layout.overflow == 0)
        for rect in [layout.notices, layout.balloon] { #expect(rect?.midX == character.midX) }
    }

    @Test("返事が無ければ、知らせの束はキャラのすぐ上に置く")
    func noticesWithoutBalloon() {
        let character = CGRect(x: 400, y: 300, width: 100, height: 100)
        let layout = make(character, notices: notices)
        #expect(layout.notices == CGRect(x: 350, y: 400 + spacing, width: 200, height: 60))
        #expect(layout.balloon == nil)
    }

    @Test("上に足りなければ一列を上下に反転し、キャラの下に吹き出しと知らせを置く。しっぽは上を指す")
    func flipAtTop() {
        let character = CGRect(x: 400, y: 700, width: 100, height: 100)
        let layout = make(character, notices: notices, balloon: balloon)
        #expect(layout.isFlipped)
        #expect(layout.tail == .up)
        #expect(layout.balloon == CGRect(x: 330, y: 700 - spacing - 80, width: 240, height: 80))
        #expect(layout.notices == CGRect(x: 350, y: 700 - spacing - 80 - spacing - 60, width: 200, height: 60))
    }

    @Test("どの位置でも、吹き出しはキャラの隣に、知らせの束は吹き出し（無ければキャラ）の隣に置き、しっぽとキャラの間に何も挟まない")
    func speechNextToCharacter() {
        let art = CGSize(width: 96, height: 104)
        let origins = [CGPoint(x: 0, y: 0), CGPoint(x: 904, y: 0), CGPoint(x: 0, y: 696), CGPoint(x: 904, y: 696), CGPoint(x: 452, y: 348)]
        for origin in origins {
            let character = CGRect(origin: origin, size: art)
            for b in [nil, balloon] as [CGSize?] {
                let layout = make(character, notices: notices, balloon: b)
                let near = layout.isFlipped ? character.minY - spacing : character.maxY + spacing
                if let placed = layout.balloon {
                    #expect((layout.isFlipped ? placed.maxY : placed.minY) == near, "\(origin)")
                    let next = layout.isFlipped ? placed.minY - spacing : placed.maxY + spacing
                    #expect((layout.isFlipped ? layout.notices!.maxY : layout.notices!.minY) == next, "\(origin)")
                } else {
                    #expect((layout.isFlipped ? layout.notices!.maxY : layout.notices!.minY) == near, "\(origin)")
                }
            }
        }
    }

    @Test("横にはみ出すパネルだけを内側にずらし、しっぽはキャラの中心を指し続ける")
    func shiftAtSides() {
        let left = make(CGRect(x: 0, y: 300, width: 100, height: 100), notices: notices, balloon: balloon)
        #expect(left.balloon?.minX == 0)
        #expect(left.notices?.minX == 0)
        #expect(left.tailX == 50)

        let right = make(CGRect(x: 900, y: 300, width: 100, height: 100), notices: notices, balloon: balloon)
        #expect(right.balloon?.maxX == 1000)
        #expect(right.notices?.maxX == 1000)
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
                        let layout = make(character, notices: n, balloon: b)
                        let rects = [layout.notices, layout.balloon].compactMap { $0 }
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

    @Test("減らしても高さが足りないときは、知らせの束を出さず、一列のパネルどうしを重ねない（画面の中にも入れる）")
    func noOverlapWhenShort() {
        let short = CGRect(x: 0, y: 0, width: 1000, height: 300)
        let tallNotices = CGSize(width: 200, height: 150)
        let tallBalloon = CGSize(width: 240, height: 150)
        for y in stride(from: 0, through: 200, by: 25) {
            let character = CGRect(x: 400, y: CGFloat(y), width: 100, height: 100)
            for n in [nil, tallNotices] as [CGSize?] {
                for b in [nil, tallBalloon] as [CGSize?] {
                    let layout = OverlayLayout.fit(visible: short, character: character, spacing: spacing) { _ in
                        (notices: n, balloon: b)
                    }
                    let rects = [layout.notices, layout.balloon].compactMap { $0 }
                    for (index, rect) in rects.enumerated() {
                        #expect(short.contains(rect), "y=\(y) \(rect)")
                        for other in rects[(index + 1)...] { #expect(rect.intersects(other) == false, "y=\(y) \(rect) \(other)") }
                    }
                    #expect(layout.balloon != nil || b == nil, "y=\(y)")
                }
            }
        }
    }

    @Test("高さが足りなければ、後ろに見せる枚数を減らし、それでも足りなければ吹き出しの行数を減らす")
    func shrinkWhenShort() {
        let short = CGRect(x: 0, y: 0, width: 1000, height: 300)
        let character = CGRect(x: 400, y: 100, width: 100, height: 100)
        var asked: [StackBudget] = []
        let layout = OverlayLayout.fit(visible: short, character: character, spacing: spacing) { budget in
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

    @Test("大きくなる吹き出しは、余裕のある向きへ伸びる")
    func growsTowardsTheRoom() {
        let tall = CGSize(width: 240, height: 600)
        // 下のほうにいるなら、余裕のある上へ。
        let low = make(CGRect(x: 450, y: 100, width: 100, height: 100), balloon: tall)
        #expect(low.isFlipped == false)
        #expect(low.balloon!.minY >= 200)
        // 上のほうにいるなら、余裕のある下へ。
        let high = make(CGRect(x: 450, y: 700, width: 100, height: 100), balloon: tall)
        #expect(high.isFlipped)
        #expect(high.balloon!.maxY <= 700)
    }

    @Test("開いた吹き出しは、余裕のある側に入るだけの行数を取る")
    func usesTheRoomThatIsThere() {
        // 上に 800 ポイント空いている。20 ポイント 1 行なら 39 行ぶん入る。
        let character = CGRect(x: 450, y: 100, width: 100, height: 100)
        let layout = OverlayLayout.fit(
            visible: CGRect(x: 0, y: 0, width: 1000, height: 1000), character: character, spacing: spacing,
            steps: StackBudget.expandedSteps
        ) { budget in (notices: nil, balloon: CGSize(width: 240, height: 20 * CGFloat(budget.lines))) }
        #expect(layout.overflow == 0)
        // 梯子の段は飛び飛びだが、入る行数から大きく取りこぼさない。
        #expect(layout.budget.lines >= 32)
    }

    @Test("開いた吹き出しは、キャラがどこにいても一列に収まり、キャラを覆わない")
    func expandedColumnNeverCoversTheCharacter() {
        // 実機に近い画面（メニューバーと Dock を除いた範囲）と、200% のキャラクター。
        let visible = CGRect(x: 0, y: 90, width: 1710, height: 950)
        let art = CGSize(width: 192, height: 208)
        let gap: CGFloat = 11
        for y in stride(from: 20, through: 900, by: 20) {
            for x in [visible.minX, visible.midX, visible.maxX - art.width] {
                let character = CGRect(origin: CGPoint(x: x, y: CGFloat(y)), size: art)
                for hasNotices in [false, true] {
                    let layout = OverlayLayout.fit(
                        visible: visible, character: character, spacing: gap, steps: StackBudget.expandedSteps
                    ) { budget in
                        // 開いた長い返事: 行数に比例して伸び、いちばん広いときは画面より高い。
                        (notices: hasNotices ? CGSize(width: 392, height: 90) : nil,
                         balloon: CGSize(width: 392, height: 26 * CGFloat(budget.lines) + 30))
                    }
                    let where_ = "y=\(y) x=\(x) notices=\(hasNotices)"
                    let rects = [layout.notices, layout.balloon].compactMap { $0 }
                    for (index, rect) in rects.enumerated() {
                        #expect(visible.contains(rect), "\(where_): \(rect) が画面から出た")
                        #expect(rect.intersects(character) == false, "\(where_): \(rect) がキャラを覆った")
                        for other in rects[(index + 1)...] {
                            #expect(rect.intersects(other) == false, "\(where_): \(rect) と \(other) が重なった")
                        }
                    }
                    #expect(layout.balloon != nil, "\(where_): 吹き出しが消えた")
                }
            }
        }
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

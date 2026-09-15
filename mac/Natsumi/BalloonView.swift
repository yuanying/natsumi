import NatsumiCore
import SwiftUI

/// What the layout decided for the column, read by the panels while they are measured and drawn.
@MainActor
@Observable
final class ColumnPlacement {
    var tail: BalloonTail = .down
    var tailX: CGFloat = 40
    var budget = StackBudget.full
    /// The widest a panel in the column may be; the input field's width.
    var width: CGFloat = InputBoxSize.default.width
}

/// natsumi's unread replies in a comic speech balloon, the oldest in front with the others stacked behind it, or dots
/// while she is receiving or thinking.
struct BalloonView: View {
    let model: AppModel
    let placement: ColumnPlacement
    let openHistory: () -> Void

    static func tailHeight(_ textScale: Double) -> CGFloat { 12 * textScale }

    var body: some View {
        let scale = model.characterScale.textScale
        let stack: ReplyStack? = if case .replies(let stack) = model.balloon.content { stack } else { nil }
        let edges = min(stack?.behind ?? 0, placement.budget.behind)
        let step = Comic.edgeStep(scale)
        let ink = Comic.outline(scale)
        let tailHeight = Self.tailHeight(scale)
        let down = placement.tail == .down
        let shape = BalloonShape(tail: placement.tail, tailX: placement.tailX - ink, tailHeight: tailHeight, radius: Comic.radius(scale))
        HStack(alignment: .top, spacing: 8 * scale) {
            content(scale: scale)
                .frame(minWidth: 24 * scale, alignment: .leading)
            Button(action: model.closeBalloon) { Image(systemName: "xmark") }
                .help(stack == nil ? "閉じる" : "すべて既読にして閉じる")
                .buttonStyle(.borderless)
                .font(.system(size: 10 * scale, weight: .bold))
                .foregroundStyle(Comic.ink)
        }
        .padding(.horizontal, 14 * scale)
        .padding(.vertical, 10 * scale)
        .padding(down ? .bottom : .top, tailHeight)
        .frame(maxWidth: max(placement.width - step * CGFloat(edges) - ink * 2, 80), alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            // The replies behind show as outlines a little away from the character.
            StackedEdges(
                count: edges, step: step, upward: down, fill: Comic.paper, lineWidth: ink,
                shape: BoxOfBalloon(tail: placement.tail, tailHeight: tailHeight, radius: Comic.radius(scale)))
            shape.fill(Comic.paper)
            shape.stroke(Comic.ink, lineWidth: ink)
        }
        .padding(.trailing, step * CGFloat(edges))
        .padding(down ? .top : .bottom, step * CGFloat(edges))
        .padding(ink)
        .environment(\.colorScheme, .light)
    }

    @ViewBuilder
    private func content(scale: Double) -> some View {
        switch model.balloon.content {
        case .receiving:
            Dots(label: "受付中", scale: scale)
        case .thinking:
            Dots(label: "考え中", scale: scale)
        case .replies(let stack):
            let preview = BalloonText.preview(stack.front.text)
            let lines = placement.budget.lines
            VStack(alignment: .leading, spacing: 4 * scale) {
                Button(action: model.confirmFrontReply) {
                    Text(preview.text)
                        .font(Comic.font(14 * scale))
                        .lineSpacing(3 * scale)
                        .foregroundStyle(Comic.ink)
                        .lineLimit(lines)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる")
                let cut = preview.isTruncated || lines < BalloonText.maxLines
                if cut || stack.more > 0 || model.balloon.isBusy {
                    // The same footer as the notices: the count first, under the text.
                    HStack(spacing: 8 * scale) {
                        if stack.more > 0 {
                            MoreCount(count: stack.more, scale: scale)
                        }
                        if cut {
                            Button("続きは履歴で", action: openHistory)
                                .buttonStyle(.link)
                                .font(Comic.font(11 * scale))
                        }
                        if model.balloon.isBusy {
                            ProgressView().controlSize(.mini).help("考え中")
                        }
                    }
                }
            }
        case nil:
            EmptyView()
        }
    }
}

private struct Dots: View {
    let label: String
    let scale: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { context in
            let count = Int(context.date.timeIntervalSinceReferenceDate / 0.4) % 3 + 1
            HStack(spacing: 6 * scale) {
                Text(String(repeating: "・", count: count))
                    .font(.system(size: 14 * scale, weight: .heavy))
                    .foregroundStyle(Comic.ink)
                    .frame(width: 40 * scale, alignment: .leading)
                Text(label).font(Comic.font(11 * scale)).foregroundStyle(Comic.faint)
            }
        }
        .help(label)
    }
}

/// A rounded box with a tail pointing at the character.
struct BalloonShape: Shape {
    var tail: BalloonTail
    var tailX: CGFloat
    var tailHeight: CGFloat
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        // SwiftUI's y grows downward: a balloon above the character has its tail at the bottom.
        let box = BoxOfBalloon(tail: tail, tailHeight: tailHeight, radius: radius).box(in: rect)
        let halfBase = min(tailHeight * 0.7, box.width / 4)
        let x = min(max(tailX, box.minX + radius + halfBase), box.maxX - radius - halfBase)
        let tip = min(max(tailX, box.minX + radius), box.maxX - radius)
        var triangle = Path()
        switch tail {
        case .down:
            triangle.move(to: CGPoint(x: x - halfBase, y: box.maxY - 1))
            triangle.addLine(to: CGPoint(x: tip, y: rect.maxY))
            triangle.addLine(to: CGPoint(x: x + halfBase, y: box.maxY - 1))
        case .up:
            triangle.move(to: CGPoint(x: x - halfBase, y: box.minY + 1))
            triangle.addLine(to: CGPoint(x: tip, y: rect.minY))
            triangle.addLine(to: CGPoint(x: x + halfBase, y: box.minY + 1))
        }
        triangle.closeSubpath()
        return Path(roundedRect: box, cornerRadius: radius).union(triangle)
    }
}

/// The balloon without its tail, for the replies stacked behind.
struct BoxOfBalloon: Shape {
    var tail: BalloonTail
    var tailHeight: CGFloat
    var radius: CGFloat

    func box(in rect: CGRect) -> CGRect {
        var box = rect
        box.size.height -= tailHeight
        if tail == .up { box.origin.y += tailHeight }
        return box
    }

    func path(in rect: CGRect) -> Path {
        Path(roundedRect: box(in: rect), cornerRadius: radius)
    }
}

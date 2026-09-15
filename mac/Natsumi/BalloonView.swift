import NatsumiCore
import SwiftUI

/// Where the balloon's tail goes, set by the layout.
@MainActor
@Observable
final class BalloonPlacement {
    var tail: BalloonTail = .down
    var tailX: CGFloat = 40
}

/// natsumi's unread replies in a comic speech balloon, the oldest in front with the others stacked behind it, or dots
/// while she is receiving or thinking.
struct BalloonView: View {
    let model: AppModel
    let placement: BalloonPlacement
    let openHistory: () -> Void

    static let maxWidth: CGFloat = 260
    static func tailHeight(_ textScale: Double) -> CGFloat { 10 * textScale }
    /// How far each stacked reply shows behind the front one.
    static func edgeStep(_ textScale: Double) -> CGFloat { 5 * textScale }

    var body: some View {
        let scale = model.characterScale.textScale
        let stack: ReplyStack? = if case .replies(let stack) = model.balloon.content { stack } else { nil }
        let edges = stack?.behind ?? 0
        let step = Self.edgeStep(scale)
        let tailHeight = Self.tailHeight(scale)
        HStack(alignment: .top, spacing: 6 * scale) {
            content(scale: scale)
                .frame(minWidth: 24 * scale, alignment: .leading)
            Button(action: model.closeBalloon) { Image(systemName: "xmark") }
                .help(stack == nil ? "閉じる" : "すべて確かめて閉じる")
                .buttonStyle(.borderless)
                .font(.system(size: 10 * scale))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12 * scale)
        .padding(.vertical, 8 * scale)
        .padding(placement.tail == .down ? .bottom : .top, tailHeight)
        .frame(maxWidth: Self.maxWidth * scale, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            let shape = BalloonShape(tail: placement.tail, tailX: placement.tailX, tailHeight: tailHeight, radius: 12 * scale)
            shape.fill(Color(nsColor: .textBackgroundColor))
            shape.stroke(Color.secondary.opacity(0.5), lineWidth: 1)
        }
        // The replies behind show as edges on the side away from the tail.
        .padding(placement.tail == .down ? .top : .bottom, step * CGFloat(edges))
        .background {
            GeometryReader { geometry in
                let size = geometry.size
                let boxHeight = size.height - step * CGFloat(edges) - tailHeight
                ForEach(Array((1...max(edges, 1)).reversed()), id: \.self) { i in
                    if i <= edges {
                        let inset = 10 * scale * CGFloat(i)
                        let y = placement.tail == .down ? step * CGFloat(edges - i) : tailHeight + step * CGFloat(i)
                        let edge = RoundedRectangle(cornerRadius: 12 * scale)
                        ZStack {
                            edge.fill(Color(nsColor: .textBackgroundColor))
                            edge.stroke(Color.secondary.opacity(0.5), lineWidth: 1)
                        }
                        .frame(width: max(size.width - inset * 2, 0), height: max(boxHeight, 0))
                        .offset(x: inset, y: y)
                    }
                }
            }
        }
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
            VStack(alignment: .leading, spacing: 4 * scale) {
                Button(action: model.confirmFrontReply) {
                    Text(preview.text)
                        .font(.system(size: 13 * scale))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる")
                if preview.isTruncated || stack.more > 0 || model.balloon.isBusy {
                    HStack(spacing: 8 * scale) {
                        if preview.isTruncated {
                            Button("続きは履歴で", action: openHistory)
                                .buttonStyle(.link)
                                .font(.system(size: 11 * scale))
                        }
                        if stack.more > 0 {
                            Text("あと \(stack.more) 件").font(.system(size: 10 * scale)).foregroundStyle(.secondary)
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
                    .font(.system(size: 13 * scale, weight: .bold))
                    .frame(width: 40 * scale, alignment: .leading)
                Text(label).font(.system(size: 10 * scale)).foregroundStyle(.secondary)
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
        var box = rect
        box.size.height -= tailHeight
        if tail == .up { box.origin.y += tailHeight }
        let halfBase = min(tailHeight * 0.8, box.width / 4)
        let x = min(max(tailX, box.minX + radius + halfBase), box.maxX - radius - halfBase)
        var triangle = Path()
        switch tail {
        case .down:
            triangle.move(to: CGPoint(x: x - halfBase, y: box.maxY - 1))
            triangle.addLine(to: CGPoint(x: tailX, y: rect.maxY))
            triangle.addLine(to: CGPoint(x: x + halfBase, y: box.maxY - 1))
        case .up:
            triangle.move(to: CGPoint(x: x - halfBase, y: box.minY + 1))
            triangle.addLine(to: CGPoint(x: tailX, y: rect.minY))
            triangle.addLine(to: CGPoint(x: x + halfBase, y: box.minY + 1))
        }
        triangle.closeSubpath()
        return Path(roundedRect: box, cornerRadius: radius).union(triangle)
    }
}

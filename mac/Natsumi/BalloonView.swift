import NatsumiCore
import SwiftUI

/// Where the balloon's tail goes, set by the layout.
@MainActor
@Observable
final class BalloonPlacement {
    var tail: BalloonTail = .down
    var tailX: CGFloat = 40
}

/// natsumi's last word in a comic speech balloon, or dots while she is receiving or thinking.
struct BalloonView: View {
    let model: AppModel
    let placement: BalloonPlacement
    let openHistory: () -> Void

    static let maxWidth: CGFloat = 260
    static func tailHeight(_ textScale: Double) -> CGFloat { 10 * textScale }

    var body: some View {
        let scale = model.characterScale.textScale
        let isNew = model.balloon.isNew
        HStack(alignment: .top, spacing: 6 * scale) {
            content(scale: scale)
                .frame(minWidth: 24 * scale, alignment: .leading)
            Button(action: model.dismissBalloon) { Image(systemName: "xmark") }
                .help("閉じる")
                .buttonStyle(.borderless)
            .font(.system(size: 10 * scale))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12 * scale)
        .padding(.vertical, 8 * scale)
        .padding(placement.tail == .down ? .bottom : .top, Self.tailHeight(scale))
        .frame(maxWidth: Self.maxWidth * scale, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            let shape = BalloonShape(tail: placement.tail, tailX: placement.tailX, tailHeight: Self.tailHeight(scale), radius: 12 * scale)
            shape.fill(Color(nsColor: .textBackgroundColor))
            shape.stroke(isNew ? Color.accentColor : Color.secondary.opacity(0.5), lineWidth: isNew ? 2 : 1)
        }
    }

    @ViewBuilder
    private func content(scale: Double) -> some View {
        switch model.balloon.content {
        case .receiving:
            Dots(label: "受付中", scale: scale)
        case .thinking:
            Dots(label: "考え中", scale: scale)
        case .message(let message):
            let preview = BalloonText.preview(message.text)
            VStack(alignment: .leading, spacing: 4 * scale) {
                if message.isNotice {
                    Label("お知らせ", systemImage: "bell").font(.system(size: 10 * scale)).foregroundStyle(.secondary)
                }
                Text(preview.text)
                    .font(.system(size: 13 * scale))
                    .fixedSize(horizontal: false, vertical: true)
                if preview.isTruncated {
                    Button("続きは履歴で", action: openHistory)
                        .buttonStyle(.link)
                        .font(.system(size: 11 * scale))
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

import NatsumiCore
import SwiftUI

/// natsumi's unread replies in a comic speech balloon, the oldest in front with the others stacked behind it, or
/// dots while she is receiving or thinking.
struct BalloonView: View {
    let props: BalloonProps?
    let text: EventSink
    let close: EventSink
    let historyLink: EventSink

    static func tailHeight(_ textScale: Double) -> CGFloat { 12 * textScale }

    var body: some View {
        if let props {
            let scale = props.textScale
            let step = Comic.edgeStep(scale)
            let ink = Comic.outline(scale)
            let tailHeight = Self.tailHeight(scale)
            let down = props.tail == .down
            let shape = BalloonShape(
                tail: props.tail, tailX: props.tailX - ink, tailHeight: tailHeight, radius: Comic.radius(scale))
            HStack(alignment: .top, spacing: 8 * scale) {
                content(props)
                    .frame(minWidth: 24 * scale, alignment: .leading)
                CloseButton(help: props.closeHelp, scale: scale) { close(.balloonCloseClicked) }
            }
            .padding(.horizontal, 14 * scale)
            .padding(.vertical, 10 * scale)
            .padding(down ? .bottom : .top, tailHeight)
            .frame(maxWidth: max(props.width - step * CGFloat(props.edges) - ink * 2, 80), alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            // The box is drawn to the height the layout gave the panel, not to the height of what it says. That
            // one number is what animates, and it is the number the panel itself arrives at, so the drawing and
            // the panel finish together with nothing to jump between them. The words are laid out whole and cut to
            // the balloon's own outline, so a line that has not been reached yet is simply not there yet.
            .frame(height: props.panelHeight.map { $0 - step * CGFloat(props.edges) - ink * 2 }, alignment: .top)
            .clipShape(shape)
            .background {
                // The replies behind show as outlines a little away from the character.
                StackedEdges(
                    count: props.edges, step: step, upward: down, fill: Comic.paper, lineWidth: ink,
                    shape: BoxOfBalloon(tail: props.tail, tailHeight: tailHeight, radius: Comic.radius(scale)))
                shape.fill(Comic.paper)
                shape.stroke(Comic.ink, lineWidth: ink)
            }
            .padding(.trailing, step * CGFloat(props.edges))
            .padding(down ? .top : .bottom, step * CGFloat(props.edges))
            .padding(ink)
            .environment(\.colorScheme, .light)
        }
    }

    @ViewBuilder
    private func content(_ props: BalloonProps) -> some View {
        let scale = props.textScale
        switch props.body {
        case .receiving:
            Dots(label: "受付中", scale: scale)
        case .thinking:
            Dots(label: "考え中", scale: scale)
        case .reply(let reply):
            VStack(alignment: .leading, spacing: 4 * scale) {
                Button { text(.balloonTextClicked) } label: {
                    Text(reply.text)
                        .font(Comic.font(14 * scale))
                        .lineSpacing(3 * scale)
                        .foregroundStyle(Comic.ink)
                        .lineLimit(reply.lineLimit)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(reply.help)
                if reply.showsHistoryLink || reply.more > 0 || props.isBusy {
                    // The same footer as the notices: the count first, under the text.
                    HStack(spacing: 8 * scale) {
                        if reply.more > 0 {
                            MoreCount(count: reply.more, scale: scale)
                        }
                        if reply.showsHistoryLink {
                            Button("続きは履歴で") { historyLink(.historyLinkClicked) }
                                .buttonStyle(.link)
                                .font(Comic.font(11 * scale))
                        }
                        if props.isBusy {
                            ProgressView().controlSize(.mini).help("考え中")
                        }
                    }
                }
            }
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

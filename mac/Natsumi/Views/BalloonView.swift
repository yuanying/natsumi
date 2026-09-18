import NatsumiCore
import SwiftUI

/// natsumi's unread replies in a comic speech balloon, the oldest in front with the others stacked behind it, or —
/// while she is receiving or thinking — the comic thought bubble with the line she is writing in it (ADR 0017).
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
            let shape = BalloonOutlineShape(
                outline: props.outline, tail: props.tail, tailX: props.tailX - ink, tailHeight: tailHeight,
                radius: Comic.radius(scale))
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
        case .thinking(let thinking):
            ThinkingLine(props: thinking, scale: scale)
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
                if reply.showsHistoryLink || reply.more > 0 {
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
                    }
                }
            }
        }
    }
}

/// What she is thinking: the line she is writing now, or the blinking dots until one arrives.
///
/// It is one line at a fixed height, so the bubble is the same size whatever she writes; a line too long for the
/// width is cut. One line crosses into the next rather than being replaced outright, and nothing is piled up:
/// only ever the newest line is there (ADR 0017).
private struct ThinkingLine: View {
    /// How long one line takes to become the next.
    static let fade: TimeInterval = 0.2

    let props: ThinkingProps
    let scale: Double

    var body: some View {
        ZStack(alignment: .leading) {
            if let line = props.line {
                Text(line)
                    .font(Comic.font(13 * scale))
                    .foregroundStyle(Comic.faint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // The line is the identity: a new one comes in as the one before it goes.
                    .id(line)
                    .transition(.opacity)
            } else {
                Dots(label: props.label, scale: scale)
                    .transition(.opacity)
            }
        }
        .frame(height: Comic.lineHeight(14 * scale), alignment: .leading)
        .animation(.easeInOut(duration: Self.fade), value: props.line)
        .help(props.label)
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

/// The outline the balloon is drawn with: the speech balloon of a reply, or the thought bubble she thinks in. The
/// tail's position animates either way, so that a card pushed sideways keeps pointing at her all the way.
struct BalloonOutlineShape: Shape {
    var outline: BalloonOutline
    var tail: BalloonTail
    var tailX: CGFloat
    var tailHeight: CGFloat
    var radius: CGFloat

    var animatableData: CGFloat {
        get { tailX }
        set { tailX = newValue }
    }

    func path(in rect: CGRect) -> Path {
        switch outline {
        case .speech:
            BalloonShape(tail: tail, tailX: tailX, tailHeight: tailHeight, radius: radius).path(in: rect)
        case .thought:
            ThoughtShape(tail: tail, tailX: tailX, tailHeight: tailHeight, radius: radius).path(in: rect)
        }
    }
}

/// The comic thought bubble: a cloud of bumps, with small circles going to the character in place of a tail. It
/// keeps to the same rectangle a speech balloon of the same size would, so the column is laid out the same way.
struct ThoughtShape: Shape {
    var tail: BalloonTail
    var tailX: CGFloat
    var tailHeight: CGFloat
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let box = BoxOfBalloon(tail: tail, tailHeight: tailHeight, radius: radius).box(in: rect)
        // The bumps reach the box's own edge from a body inset by their radius, so the cloud stays inside it.
        let bump = max(4, min(radius * 0.9, box.height / 4))
        let body = box.insetBy(dx: bump, dy: bump)
        guard body.width > 0, body.height > 0 else { return Path(roundedRect: box, cornerRadius: radius) }
        var path = Path(roundedRect: body, cornerRadius: max(radius - bump, 2))
        func circle(_ centre: CGPoint, _ diameter: CGFloat) {
            path = path.union(Path(ellipseIn: CGRect(
                x: centre.x - diameter / 2, y: centre.y - diameter / 2, width: diameter, height: diameter)))
        }
        let across = max(2, Int((body.width / (bump * 1.7)).rounded()))
        for i in 0...across {
            let x = body.minX + body.width * CGFloat(i) / CGFloat(across)
            circle(CGPoint(x: x, y: body.minY), bump * 2)
            circle(CGPoint(x: x, y: body.maxY), bump * 2)
        }
        let down = max(1, Int((body.height / (bump * 1.7)).rounded()))
        for i in 0...down {
            let y = body.minY + body.height * CGFloat(i) / CGFloat(down)
            circle(CGPoint(x: body.minX, y: y), bump * 2)
            circle(CGPoint(x: body.maxX, y: y), bump * 2)
        }
        // The thought trailing off towards her: two circles, the further one smaller.
        let x = min(max(tailX, box.minX + radius), box.maxX - radius)
        for (along, size) in [(0.30, 0.46), (0.74, 0.28)] {
            let y = tail == .down
                ? box.maxY + tailHeight * along
                : box.minY - tailHeight * along
            circle(CGPoint(x: x, y: y), tailHeight * size)
        }
        return path
    }
}

/// A rounded box with a tail pointing at the character. The tail's position animates with the box, so that a
/// card pushed sideways while it opens keeps pointing at her all the way.
struct BalloonShape: Shape {
    var tail: BalloonTail
    var tailX: CGFloat
    var tailHeight: CGFloat
    var radius: CGFloat

    var animatableData: CGFloat {
        get { tailX }
        set { tailX = newValue }
    }

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

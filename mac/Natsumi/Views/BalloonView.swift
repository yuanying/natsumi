import NatsumiCore
import SwiftUI

/// natsumi's last reply in a comic speech balloon, one only and while it is unread (ADR 0022), or — while she is receiving or thinking —
/// the comic thought bubble with the line she is writing in it (ADR 0017).
struct BalloonView: View {
    let props: BalloonProps?
    let text: EventSink
    let close: EventSink
    let historyLink: EventSink
    let images: EventSink

    /// The room kept below (or above) the box for what points at the character: a tail for a reply, and the
    /// wider trail of circles for a thought.
    static func tailHeight(_ textScale: Double, outline: BalloonOutline = .speech) -> CGFloat {
        (outline == .thought ? 20 : 12) * textScale
    }

    var body: some View {
        if let props {
            let scale = props.textScale
            let ink = Comic.outline(scale)
            let tailHeight = Self.tailHeight(scale, outline: props.outline)
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
            .frame(maxWidth: max(props.width - ink * 2, 80), alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            // The box is drawn to the height the layout gave the panel, not to the height of what it says. That
            // one number is what animates, and it is the number the panel itself arrives at, so the drawing and
            // the panel finish together with nothing to jump between them. The words are laid out whole and cut to
            // the balloon's own outline, so a line that has not been reached yet is simply not there yet.
            .frame(height: props.panelHeight.map { $0 - ink * 2 }, alignment: .top)
            .clipShape(shape)
            .background {
                shape.fill(Comic.paper)
                shape.stroke(Comic.ink, lineWidth: ink)
            }
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
                // Not a Button: a button's label takes every click, and a link in the text has to get its own. The
                // text view follows a click on a link; a click anywhere else on the text is the balloon's, as it
                // always was (ADR 0038).
                LinkedText(
                    runs: reply.runs, font: Comic.nsFont(14 * scale), lineSpacing: 3 * scale,
                    lineLimit: reply.lineLimit, click: .balloonTextClicked, fillsWidth: true, sink: text)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isButton)
                    .help(reply.help)
                // The pictures she attached, small and at sizes fixed before they come, so the balloon keeps its
                // size; each is its own button, apart from the text's click (ADR 0045).
                if !reply.images.isEmpty {
                    ImageStripView(tiles: reply.images, spacing: 6 * scale) { images(.imageClicked(imageId: $0)) }
                        .padding(.vertical, 2 * scale)
                }
                // She is still at it after saying this: what she is thinking goes under what she said, in grey and
                // one line high, so the reply stays in front (ADR 0025).
                if let thinking = reply.thinking {
                    HStack(spacing: 4 * scale) {
                        Image(systemName: "cloud")
                            .font(.system(size: 10 * scale))
                            .foregroundStyle(Comic.faint)
                        ThinkingLine(props: thinking, scale: scale)
                    }
                }
                // The same footer as the notices: the count first, under the text. A reply is shown only while it
                // is unread, so there is always a count (ADR 0022).
                HStack(spacing: 8 * scale) {
                    UnreadCount(count: reply.unread, scale: scale)
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
                    // The end of the line is where she is writing, so that is the end that is kept. Cutting the
                    // tail instead would leave the owner reading text she had already gone past.
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // The line is the identity: a new one comes in as the one before it goes.
                    .id(line)
                    .transition(.opacity)
            } else {
                Dots(label: props.label, scale: scale)
                    .transition(.opacity)
            }
        }
        // The whole width, dots or line alike, so that the × does not move when the first line arrives.
        .frame(maxWidth: .infinity, alignment: .leading)
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

/// The comic thought bubble: a cloud of big soft lobes, with circles trailing off to the character in place of a
/// tail. It keeps to the same rectangle a speech balloon of the same size would, so the column is laid out the
/// same way.
struct ThoughtShape: Shape {
    var tail: BalloonTail
    var tailX: CGFloat
    var tailHeight: CGFloat
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let box = BoxOfBalloon(tail: tail, tailHeight: tailHeight, radius: radius).box(in: rect)
        // The lobes reach the box's own edge from a body inset by how far they stand out, so the cloud stays inside
        // the rectangle the column gave it.
        let reach = max(3, min(radius * 0.9, box.height / 4))
        let body = box.insetBy(dx: reach, dy: reach)
        guard body.width > 0, body.height > 0 else { return Path(roundedRect: box, cornerRadius: radius) }
        var path = Path(roundedRect: body, cornerRadius: max(radius - reach, 2))
        func lobe(at centre: CGPoint, _ size: CGSize) {
            path = path.union(Path(ellipseIn: CGRect(
                x: centre.x - size.width / 2, y: centre.y - size.height / 2,
                width: size.width, height: size.height)))
        }
        // A few wide lobes along the top and the bottom. A balloon this long is drawn with a handful of big soft
        // bumps; one small circle after another would read as a doily rather than a cloud.
        let across = max(2, Int((body.width / max(box.height * 1.2, 1)).rounded()))
        let bump = CGSize(width: min(body.width, body.width / CGFloat(across) * 1.15), height: reach * 2)
        // The outermost lobe's own edge sits on the body's, so no lobe reaches past the rectangle sideways.
        let span = body.width - bump.width
        for i in 0...across {
            let x = body.minX + bump.width / 2 + span * CGFloat(i) / CGFloat(across)
            lobe(at: CGPoint(x: x, y: body.minY), bump)
            lobe(at: CGPoint(x: x, y: body.maxY), bump)
        }
        // One lobe on each side, so the ends are round rather than pinched between two bumps.
        let side = CGSize(width: reach * 2, height: body.height * 0.9)
        lobe(at: CGPoint(x: body.minX, y: body.midY), side)
        lobe(at: CGPoint(x: body.maxX, y: body.midY), side)
        // The thought trailing off towards her: two circles, the further one smaller.
        let x = min(max(tailX, box.minX + radius), box.maxX - radius)
        let trail = min(reach * 1.6, tailHeight * 0.5)
        for (along, size) in [(0.32, 1.0), (0.76, 0.62)] {
            let y = tail == .down ? box.maxY + tailHeight * along : box.minY - tailHeight * along
            lobe(at: CGPoint(x: x, y: y), CGSize(width: trail * size, height: trail * size))
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

/// The balloon without its tail: the box the outlines are drawn around.
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

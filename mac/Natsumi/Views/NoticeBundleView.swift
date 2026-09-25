import NatsumiCore
import SwiftUI

/// Unchecked notices at the far end of the column: yellow comic cards, the oldest in front, the others stacked
/// behind.
struct NoticeBundleView: View {
    let props: NoticeBundleProps?
    let card: EventSink
    let close: EventSink
    let historyLink: EventSink

    var body: some View {
        if let props {
            let scale = props.textScale
            let step = Comic.edgeStep(scale)
            let ink = Comic.outline(scale)
            let shape = RoundedRectangle(cornerRadius: Comic.radius(scale))
            HStack(alignment: .top, spacing: 8 * scale) {
                content(props)
                CloseButton(help: props.closeHelp, scale: scale) { close(.noticeCloseClicked) }
            }
            .padding(.horizontal, 14 * scale)
            .padding(.vertical, 10 * scale)
            .frame(maxWidth: max(props.width - step * CGFloat(props.edges) - ink * 2, 80), alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            // Drawn to the height the layout gave the panel, and cut to the card's own outline (see `BalloonView`).
            .frame(height: props.panelHeight.map { $0 - step * CGFloat(props.edges) - ink * 2 }, alignment: .top)
            .clipShape(shape)
            .background {
                StackedEdges(
                    count: props.edges, step: step, upward: props.edgesUpward, fill: Comic.noticePaper,
                    lineWidth: ink, shape: shape)
                shape.fill(Comic.noticePaper)
                shape.stroke(Comic.ink, lineWidth: ink)
            }
            .padding(.trailing, step * CGFloat(props.edges))
            .padding(props.edgesUpward ? .top : .bottom, step * CGFloat(props.edges))
            .padding(ink)
            .environment(\.colorScheme, .light)
        }
    }

    private func content(_ props: NoticeBundleProps) -> some View {
        let scale = props.textScale
        return VStack(alignment: .leading, spacing: 4 * scale) {
            HStack(spacing: 6 * scale) {
                Image(systemName: "bell.fill").font(.system(size: 10 * scale, weight: .bold))
                Text("お知らせ").font(Comic.font(11 * scale, bold: true))
            }
            .foregroundStyle(Comic.ink)
            // Not a Button, so that a link in the text gets its own click (see `BalloonView`, ADR 0038).
            LinkedText(
                runs: props.runs, font: Comic.nsFont(13 * scale), lineSpacing: 3 * scale,
                lineLimit: props.lineLimit, click: .noticeTextClicked, fillsWidth: true, sink: card)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isButton)
                .help(props.help)
            if props.more > 0 || props.showsHistoryLink {
                // The same footer as the replies: the count first, under the text.
                HStack(spacing: 8 * scale) {
                    if props.more > 0 {
                        MoreCount(count: props.more, scale: scale)
                    }
                    if props.showsHistoryLink {
                        Button("続きは履歴で") { historyLink(.historyLinkClicked) }
                            .buttonStyle(.link)
                            .font(Comic.font(11 * scale))
                    }
                }
            }
        }
    }
}

/// "あと N 件" under the front card, alike for replies and notices.
struct MoreCount: View {
    let count: Int
    let scale: Double

    var body: some View {
        Text("あと \(count) 件").font(Comic.font(11 * scale, bold: true)).foregroundStyle(Comic.faint)
    }
}

/// How many replies are unread, in the balloon's footer where the notices say how many are behind.
struct UnreadCount: View {
    let count: Int
    let scale: Double

    var body: some View {
        Text("未読 \(count) 件").font(Comic.font(11 * scale, bold: true)).foregroundStyle(Comic.faint)
    }
}

/// The × at the top right of a card.
struct CloseButton: View {
    let help: String
    let scale: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) { Image(systemName: "xmark") }
            .help(help)
            .buttonStyle(.borderless)
            .font(.system(size: 10 * scale, weight: .bold))
            .foregroundStyle(Comic.ink)
    }
}

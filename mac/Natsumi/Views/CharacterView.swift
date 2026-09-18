import NatsumiCore
import SwiftUI

/// The character herself: the avatar at the chosen size, a small mark while she is not connected, and the yellow
/// count of unchecked notices. The clicks on her are handled by the panel's view, which knows where the badge is.
struct CharacterView: View {
    let props: CharacterProps?

    var body: some View {
        if let props {
            let scale = props.scale
            TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
                art(props, elapsed: context.date.timeIntervalSinceReferenceDate)
            }
            .frame(width: scale.artSize.width, height: scale.artSize.height)
            .overlay(alignment: .bottomTrailing) {
                if let help = props.disconnectedHelp {
                    Circle().fill(.gray).frame(width: 10, height: 10).padding(4).help(help)
                }
            }
            .overlay(alignment: .topLeading) {
                if let badge = props.badge { self.badge(badge) }
            }
        }
    }

    @ViewBuilder
    private func art(_ props: CharacterProps, elapsed: TimeInterval) -> some View {
        let size = props.scale.artSize
        switch props.avatar {
        case .sprite(let asset):
            // Frames are 2x pixels; they are resampled smoothly to the chosen size.
            Image(decorative: asset.frame(for: props.expression, elapsed: elapsed), scale: 2)
                .resizable()
                .interpolation(.high)
                .antialiased(true)
                .frame(width: size.width, height: size.height)
        case .placeholder:
            Text(PlaceholderArt.symbol(for: props.expression))
                .font(.system(size: 64 * props.scale.value))
        }
    }

    private func badge(_ badge: BadgeProps) -> some View {
        let frame = badge.frame
        let ink = max(1.5, frame.height / 10)
        return ZStack {
            Circle().fill(Comic.badge)
            Circle().stroke(Comic.ink, lineWidth: ink)
            Text(badge.count > 99 ? "99+" : "\(badge.count)")
                .font(Comic.font(frame.height * (badge.count > 9 ? 0.45 : 0.6), bold: true))
                .foregroundStyle(Comic.ink)
                .minimumScaleFactor(0.5)
        }
        .frame(width: frame.width - ink, height: frame.height - ink)
        .offset(x: frame.minX + ink / 2, y: frame.minY + ink / 2)
        .help(badge.help)
    }
}

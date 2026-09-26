import NatsumiCore
import SwiftUI

/// One small picture at the size its props give it: a blank while it is on its way, the picture once it has come,
/// and a mark where it could not be had. Only a picture that came is a button (ADR 0045).
struct ImageTileView: View {
    let props: ImageTileProps
    let open: () -> Void

    var body: some View {
        if props.canOpen {
            Button(action: open) { picture }
                .buttonStyle(.plain)
                .help(props.help)
                .accessibilityLabel(props.label)
                .accessibilityHint(props.help)
        } else {
            picture
                .help(props.help)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(props.label)、\(props.help)")
        }
    }

    private var picture: some View {
        let shape = RoundedRectangle(cornerRadius: min(8, props.size.height / 6))
        return ZStack {
            switch props.content {
            case .loaded(let image):
                Image(decorative: image.thumbnail, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
            case .loading:
                Color.gray.opacity(0.15)
                ProgressView().controlSize(.small)
            case .failed:
                Color.gray.opacity(0.15)
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.system(size: min(props.size.height * 0.3, 22)))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: props.size.width, height: props.size.height)
        .clipShape(shape)
        .overlay(shape.stroke(Color.black.opacity(0.35), lineWidth: 1))
        .contentShape(shape)
    }
}

/// The small pictures of one line or one approval, in a row.
struct ImageStripView: View {
    let tiles: [ImageTileProps]
    let spacing: CGFloat
    let open: (String) -> Void

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(tiles) { tile in
                ImageTileView(props: tile) { open(tile.imageId) }
            }
        }
    }
}

import AppKit
import NatsumiCore
import SwiftUI

/// The window a picture is opened large in (ADR 0045). It comes up when the owner clicks a small picture in the
/// balloon or the history, in the character's layer like the settings, and closes with its close button or Esc.
@MainActor
final class ImageViewerComponent: Component {
    let panel = OverlayPanel.make(style: [.titled, .closable, .resizable], acceptsKey: true)
    private var applied: ImageViewerProps?
    private var hosting: NSHostingView<ImageViewerView>!

    init() {
        super.init(name: "imageViewer")
        hosting = NSHostingView(rootView: ImageViewerView(props: nil))
        hosting.sizingOptions = []
        panel.isOpaque = true
        panel.backgroundColor = .windowBackgroundColor
        panel.contentView = hosting
        panel.minSize = NSSize(width: 160, height: 120)
        panel.onCancel = { [weak self] in self?.dispatch(.imageViewerCloseRequested) }
        panel.onCommand = { [weak self] key in
            guard key == "w" else { return false }
            self?.dispatch(.imageViewerCloseRequested)
            return true
        }
    }

    /// Shows the picture, sized to it within `visible` and centered there when it is a new one; hides the window
    /// when there is none.
    func render(_ props: ImageViewerProps?, visible: CGRect) {
        guard props != applied else { return }
        let previous = applied
        applied = props
        guard let props else {
            panel.orderOut(nil)
            return
        }
        panel.title = props.title
        hosting.rootView = ImageViewerView(props: props)
        guard previous?.image != props.image else { return }
        let size = Self.fit(props.image.pixelSize, in: visible.size)
        panel.setContentSize(size)
        let frame = panel.frame
        panel.setFrameOrigin(NSPoint(x: visible.midX - frame.width / 2, y: visible.midY - frame.height / 2))
        panel.makeKeyAndOrderFront(nil)
    }

    /// The picture at its own size in points, shrunk to fit most of the screen.
    private static func fit(_ pixels: CGSize, in room: CGSize) -> CGSize {
        let limit = CGSize(width: room.width * 0.8, height: room.height * 0.8 - 40)
        let scale = min(1, limit.width / max(pixels.width, 1), limit.height / max(pixels.height, 1))
        return CGSize(width: max(floor(pixels.width * scale), 160), height: max(floor(pixels.height * scale), 120))
    }
}

/// The picture, whole, fitted to the window.
struct ImageViewerView: View {
    let props: ImageViewerProps?

    var body: some View {
        if let props, let image = props.image.full() {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .accessibilityLabel(props.title)
        } else {
            Color.black
        }
    }
}

import AppKit
import NatsumiCore
import SwiftUI

/// The history window. It is not in the column and not a child of the character's panel: a titled window kept on
/// the screen by AppKit would otherwise pull the character along with it.
@MainActor
final class HistoryComponent: Component {
    static let size = NSSize(width: 340, height: 440)

    let panel = OverlayPanel.make(style: [.titled, .closable, .resizable], acceptsKey: true)
    private var applied: HistoryProps?
    private var hosting: NSHostingView<HistoryView>!

    init() {
        super.init(name: "history")
        hosting = NSHostingView(rootView: HistoryView(props: nil, send: sink))
        panel.title = "natsumi の履歴"
        panel.setContentSize(Self.size)
        panel.contentView = hosting
        panel.onCancel = { [weak self] in self?.dispatch(.historyCloseRequested) }
        // Opaque, so the history reads well over any window in both appearances.
        panel.isOpaque = true
        panel.backgroundColor = .windowBackgroundColor
    }

    func render(_ props: HistoryProps?) {
        guard props != applied else { return }
        applied = props
        hosting.rootView = HistoryView(props: props, send: sink)
    }
}

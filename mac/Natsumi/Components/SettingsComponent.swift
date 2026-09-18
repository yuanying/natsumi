import AppKit
import NatsumiCore
import SwiftUI

/// The settings window, in the character's layer so that it opens without bringing the app to the front.
@MainActor
final class SettingsComponent: Component {
    let panel = OverlayPanel.make(style: [.titled, .closable], acceptsKey: true)
    private var applied: SettingsProps?
    private var hosting: NSHostingView<SettingsView>!

    init() {
        super.init(name: "settings")
        hosting = NSHostingView(rootView: SettingsView(props: nil, send: sink))
        panel.title = "natsumi の設定"
        panel.isOpaque = true
        panel.backgroundColor = .windowBackgroundColor
        panel.contentView = hosting
        panel.onCancel = { [weak self] in self?.dispatch(.settingsCloseRequested) }
    }

    func render(_ props: SettingsProps) {
        guard props != applied else { return }
        let first = applied == nil
        applied = props
        hosting.rootView = SettingsView(props: props, send: sink)
        // The panel is sized once, to what the form asks for.
        if first { panel.setContentSize(hosting.fittingSize) }
    }
}

import AppKit
import NatsumiCore
import SwiftUI

/// The speech balloon. Its text and its × mean different things, so each is a component of its own.
@MainActor
final class BalloonComponent: Component {
    let panel = OverlayPanel.make()
    private let text = Component(name: "balloon.text")
    private let close = Component(name: "balloon.close")
    private let historyLink = Component(name: "balloon.historyLink")
    private var applied: BalloonProps?
    private var hosting: FirstMouseHostingView<BalloonView>!

    init() {
        super.init(name: "balloon")
        adopt(text)
        adopt(close)
        adopt(historyLink)
        hosting = FirstMouseHostingView(rootView: view(nil))
        panel.contentView = hosting
    }

    func view(_ props: BalloonProps?) -> BalloonView {
        BalloonView(props: props, text: text.sink, close: close.sink, historyLink: historyLink.sink)
    }

    /// The same drawing, for measuring only: nothing it shows is meant to be acted on.
    func probe(_ props: BalloonProps) -> BalloonView {
        BalloonView(props: props, fillsPanel: false, text: .ignored, close: .ignored, historyLink: .ignored)
    }

    func render(_ props: BalloonProps?) {
        guard props != applied else { return }
        applied = props
        hosting.rootView = view(props)
    }
}

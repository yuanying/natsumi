import AppKit
import NatsumiCore
import SwiftUI

/// The yellow bundle of unchecked notices. Its front card and its × mean different things.
@MainActor
final class NoticeBundleComponent: Component {
    let panel = OverlayPanel.make()
    private let card = Component(name: "notices.card")
    private let close = Component(name: "notices.close")
    private let historyLink = Component(name: "notices.historyLink")
    private var applied: NoticeBundleProps?
    private var hosting: FirstMouseHostingView<CardPanel<NoticeBundleProps?, NoticeBundleView>>!

    init() {
        super.init(name: "notices")
        adopt(card)
        adopt(close)
        adopt(historyLink)
        hosting = FirstMouseHostingView(rootView: view(nil))
        panel.contentView = hosting
    }

    /// The drawing animates itself and reports the size it has reached; the panel follows it (ADR 0016).
    var onSize: @MainActor (CGSize) -> Void = { _ in }

    func view(_ props: NoticeBundleProps?) -> CardPanel<NoticeBundleProps?, NoticeBundleView> {
        CardPanel(
            value: props, content: NoticeBundleView(props: props, card: card.sink, close: close.sink, historyLink: historyLink.sink),
            onSize: { [weak self] size in self?.onSize(size) })
    }

    /// The same drawing, for measuring only.
    func probe(_ props: NoticeBundleProps) -> NoticeBundleView {
        NoticeBundleView(props: props, card: .ignored, close: .ignored, historyLink: .ignored)
    }

    func render(_ props: NoticeBundleProps?) {
        guard props != applied else { return }
        applied = props
        hosting.rootView = view(props)
    }
}

import NatsumiCore
import SwiftUI

/// The yellow bundle of unchecked notices. Its front card and its × mean different things. It is drawn on the
/// stage; the root places it there.
@MainActor
final class NoticeBundleComponent: Component {
    private let card = Component(name: "notices.card")
    private let close = Component(name: "notices.close")
    private let historyLink = Component(name: "notices.historyLink")

    init() {
        super.init(name: "notices")
        adopt(card)
        adopt(close)
        adopt(historyLink)
    }

    func view(_ props: NoticeBundleProps) -> NoticeBundleView {
        NoticeBundleView(props: props, card: card.sink, close: close.sink, historyLink: historyLink.sink)
    }

    /// The same drawing, for measuring only.
    func probe(_ props: NoticeBundleProps) -> NoticeBundleView {
        NoticeBundleView(props: props, card: .ignored, close: .ignored, historyLink: .ignored)
    }
}

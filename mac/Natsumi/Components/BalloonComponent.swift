import NatsumiCore
import SwiftUI

/// The speech balloon. Its text and its × mean different things, so each is a component of its own. It is drawn on
/// the stage; the root places it there.
@MainActor
final class BalloonComponent: Component {
    private let text = Component(name: "balloon.text")
    private let close = Component(name: "balloon.close")
    private let historyLink = Component(name: "balloon.historyLink")

    init() {
        super.init(name: "balloon")
        adopt(text)
        adopt(close)
        adopt(historyLink)
    }

    func view(_ props: BalloonProps) -> BalloonView {
        BalloonView(props: props, text: text.sink, close: close.sink, historyLink: historyLink.sink)
    }

    /// The same drawing, for measuring only: nothing it shows is meant to be acted on.
    func probe(_ props: BalloonProps) -> BalloonView {
        BalloonView(props: props, text: .ignored, close: .ignored, historyLink: .ignored)
    }
}

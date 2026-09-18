import AppKit
import NatsumiCore
import SwiftUI

/// The character's panel. Her badge is a component of its own, because a click on it means something else than a
/// click on her.
@MainActor
final class CharacterComponent: Component {
    let panel = OverlayPanel.make()
    private let badge = Component(name: "character.badge")
    private var applied: CharacterProps?
    private var hosting: ClickOrDragHostingView<CharacterView>!

    init(menu: @escaping @MainActor () -> NSMenu?, pointerMoved: @escaping @MainActor () -> Void) {
        super.init(name: "character")
        adopt(badge)
        hosting = ClickOrDragHostingView(
            rootView: CharacterView(props: nil),
            onClick: { [weak self] point in
                guard let self else { return }
                // Where the click landed is a drawing parameter, so the panel settles it here and the event is
                // raised in the part it belongs to.
                if let frame = self.applied?.badge?.frame, frame.contains(point) {
                    self.badge.dispatch(.badgeClicked)
                } else {
                    self.dispatch(.characterClicked)
                }
            },
            onDrag: { [weak self] begun in self?.dispatch(begun ? .characterDragBegan : .characterDragEnded) },
            onPointer: pointerMoved,
            menu: menu)
        panel.contentView = hosting
    }

    func render(_ props: CharacterProps) {
        guard props != applied else { return }
        applied = props
        hosting.rootView = CharacterView(props: props)
    }
}

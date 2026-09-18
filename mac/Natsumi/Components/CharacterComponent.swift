import AppKit
import NatsumiCore
import SwiftUI

/// The character. Her badge is a component of its own, because a click on it means something else than a click on
/// her. She is drawn on the stage; the root places her there.
@MainActor
final class CharacterComponent: Component {
    private let badge = Component(name: "character.badge")
    private var applied: CharacterProps?
    private var mouse: CharacterMouseArea!

    /// `carried`: the owner's drag, after its event has been raised, so that the root can move her by that much.
    init(carried: @escaping @MainActor (CharacterDrag) -> Void, menu: @escaping @MainActor () -> NSMenu?) {
        super.init(name: "character")
        adopt(badge)
        mouse = CharacterMouseArea(
            onClick: { [weak self] point in
                guard let self else { return }
                // Where the click landed is a drawing parameter, so it is settled here and the event is raised in
                // the part it belongs to.
                if let frame = self.applied?.badge?.frame, frame.contains(point) {
                    self.badge.dispatch(.badgeClicked)
                } else {
                    self.dispatch(.characterClicked)
                }
            },
            onDrag: { [weak self] phase in
                guard let self else { return }
                switch phase {
                case .began: self.dispatch(.characterDragBegan)
                case .moved: break
                case .ended: self.dispatch(.characterDragEnded)
                }
                carried(phase)
            },
            menu: menu)
    }

    func view(_ props: CharacterProps) -> CharacterStageView {
        applied = props
        return CharacterStageView(props: props, mouse: mouse)
    }
}

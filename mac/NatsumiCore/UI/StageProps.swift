import CoreGraphics
import Foundation

/// How a change to the stage is shown: at once, as a card opening or folding, or as a run of the character.
///
/// The root chooses it for each drawing pass; the stage's view turns it into the time and the curve. Nothing in the
/// mediator or the derivation decides how long anything takes.
public enum StageTransition: Equatable, Sendable {
    /// Drawn where it is, with nothing in between: the owner's drag, a change of scale, the first drawing.
    case immediate
    /// A card opening or folding, and the column settling around it.
    case card
    /// The character running, over this many seconds. The column goes with her over the same time.
    case run(TimeInterval)
}

/// Everything drawn on the stage, and where: the character and the two cards, each with its frame in the stage's
/// own coordinates (origin at the top left, as SwiftUI lays out). The conversation window and the settings are
/// windows of their own and are not here.
public struct StageProps: Equatable, Sendable {
    public var size: CGSize
    public var character: CharacterProps
    public var characterFrame: CGRect
    public var balloon: BalloonProps?
    public var balloonFrame: CGRect?
    public var notices: NoticeBundleProps?
    public var noticesFrame: CGRect?
    public var transition: StageTransition

    public init(
        size: CGSize, character: CharacterProps, characterFrame: CGRect, balloon: BalloonProps?, balloonFrame: CGRect?,
        notices: NoticeBundleProps?, noticesFrame: CGRect?, transition: StageTransition
    ) {
        self.size = size
        self.character = character
        self.characterFrame = characterFrame
        self.balloon = balloon
        self.balloonFrame = balloonFrame
        self.notices = notices
        self.noticesFrame = noticesFrame
        self.transition = transition
    }

    /// Puts the column the layout worked out, in screen coordinates, onto a stage that covers `stage` of the screen.
    public static func make(
        root: RootProps, character: CGRect, layout: OverlayLayout, stage: CGRect, transition: StageTransition
    ) -> StageProps {
        StageProps(
            size: stage.size,
            character: root.character,
            characterFrame: StageLayout.onStage(character, stage: stage),
            balloon: root.balloon,
            balloonFrame: layout.balloon.map { StageLayout.onStage($0, stage: stage) },
            notices: root.notices,
            noticesFrame: layout.notices.map { StageLayout.onStage($0, stage: stage) },
            transition: transition)
    }
}

public enum StageLayout {
    /// A screen rectangle (origin at the bottom left) as the stage sees it (origin at the top left).
    public static func onStage(_ rect: CGRect, stage: CGRect) -> CGRect {
        CGRect(x: rect.minX - stage.minX, y: stage.maxY - rect.maxY, width: rect.width, height: rect.height)
    }
}

import CoreGraphics

/// Where the balloon's tail points.
public enum BalloonTail: Equatable, Sendable {
    /// The balloon is above the character.
    case down
    /// The column is flipped and the balloon is below the character.
    case up
}

/// How much of the stacks to show. When the column does not fit, fewer cards show behind the front one, and then the
/// front reply shows fewer lines.
public struct StackBudget: Equatable, Sendable {
    public var behind: Int
    public var lines: Int

    public init(behind: Int, lines: Int) {
        self.behind = behind
        self.lines = lines
    }

    public static let full = StackBudget(behind: NoticeStack.maxBehind, lines: BalloonText.maxLines)
    public static let steps: [StackBudget] = [
        full, StackBudget(behind: 0, lines: BalloonText.maxLines), StackBudget(behind: 0, lines: 2), StackBudget(behind: 0, lines: 1),
    ]
    /// The ladder while a card is open: it starts at the whole text and comes down to the same last steps, so an
    /// opened card that cannot fit ends up no worse than a closed one. The steps are close together near the top so
    /// that a card takes as much of the room on its side as there is, rather than falling a long way past it.
    public static let expandedSteps: [StackBudget] = [
        StackBudget(behind: NoticeStack.maxBehind, lines: BalloonText.expandedMaxLines),
        StackBudget(behind: 0, lines: BalloonText.expandedMaxLines),
        StackBudget(behind: 0, lines: 32),
        StackBudget(behind: 0, lines: 24),
        StackBudget(behind: 0, lines: 18),
        StackBudget(behind: 0, lines: 12),
        StackBudget(behind: 0, lines: 8),
        StackBudget(behind: 0, lines: BalloonText.maxLines),
        StackBudget(behind: 0, lines: 3),
        StackBudget(behind: 0, lines: 2),
        StackBudget(behind: 0, lines: 1),
    ]
}

/// Where the panels around the character go, in screen coordinates (origin at the bottom left).
///
/// The panels stand in one column on the character's vertical center line: from the top, the notices, the balloon
/// and the character. When there is not room above, the column flips (notices and balloon below); a panel that
/// would leave the screen sideways moves inward on its own. The balloon always stays next to the character. The
/// conversation window is not in the column and does not follow her (ADR 0021). The column grows towards whichever
/// side of the character has the room for it; the character herself is never moved.
public struct OverlayLayout: Equatable, Sendable {
    /// How far the tail stays from the balloon's sides.
    public static let tailInset: CGFloat = 18

    public var notices: CGRect?
    public var balloon: CGRect?
    public var tail: BalloonTail = .down
    /// The tail's position from the balloon's left side.
    public var tailX: CGFloat = 0
    public var isFlipped = false
    /// How much height the column lacks on the screen; 0 when it fits.
    public var overflow: CGFloat = 0
    public var budget = StackBudget.full

    /// How much wider an opened card may be than the rest of the column. Beyond this a line of text is too long to
    /// read comfortably, whatever room the screen has.
    public static let expandedWidthFactor: CGFloat = 2
    /// What an opened card leaves at the sides of the screen.
    public static let expandedSideMargin: CGFloat = 24

    /// How wide an opened card may be: as wide as there is room for, up to the factor, and never narrower than the
    /// rest of the column. Near the side of a screen the wide card is pushed inward like any other panel; the stage
    /// moves it and grows it in one motion, and the tail follows the character (ADR 0016).
    public static func expandedWidth(_ width: CGFloat, visible: CGRect) -> CGFloat {
        min(width * expandedWidthFactor, max(width, visible.width - expandedSideMargin * 2))
    }

    /// The gap between the character and the panels and between the panels, growing with the character.
    public static func spacing(for scale: CharacterScale) -> CGFloat {
        8 * scale.textScale
    }

    /// Lays the column out with the most of the stacks that fits. `measure` gives the sizes of the notices and the
    /// balloon when they show that much.
    public static func fit(
        visible: CGRect, character: CGRect, spacing: CGFloat, steps: [StackBudget] = StackBudget.steps,
        measure: (StackBudget) -> (notices: CGSize?, balloon: CGSize?)
    ) -> OverlayLayout {
        var layout = OverlayLayout()
        var last: (notices: CGSize?, balloon: CGSize?) = (nil, nil)
        for budget in steps {
            last = measure(budget)
            layout = make(
                visible: visible, character: character, spacing: spacing, notices: last.notices, balloon: last.balloon)
            layout.budget = budget
            if layout.overflow == 0 { break }
        }
        if layout.overflow > 0, last.notices != nil {
            // Still too tall: leave the notices out (the badge still counts them) rather than piling panels on each
            // other.
            let budget = layout.budget
            layout = make(visible: visible, character: character, spacing: spacing, notices: nil, balloon: last.balloon)
            layout.budget = budget
        }
        return layout
    }

    public static func make(
        visible: CGRect, character: CGRect, spacing: CGFloat, notices: CGSize?, balloon: CGSize?
    ) -> OverlayLayout {
        let roomAbove = visible.maxY - character.maxY
        let roomBelow = character.minY - visible.minY
        func need(_ size: CGSize?) -> CGFloat { size.map { $0.height + spacing } ?? 0 }
        let speech = need(balloon) + need(notices)

        // The column goes to whichever side of her has the room for it; upright is the default, and it gives way
        // only when the other side can hold more of the column (ADR 0016).
        let normal = max(0, speech - roomAbove)
        let flip = max(0, speech - roomBelow)
        let flipped = flip < normal

        var layout = OverlayLayout()
        layout.isFlipped = flipped
        layout.tail = flipped ? .up : .down
        layout.overflow = flipped ? flip : normal

        // Panels on the speech side stack away from the character, each at its own distance.
        var edge = flipped ? character.minY : character.maxY
        var stack: [WritableKeyPath<OverlayLayout, CGRect?>] = []
        func stacked(_ size: CGSize, into key: WritableKeyPath<OverlayLayout, CGRect?>) {
            let y = flipped ? edge - spacing - size.height : edge + spacing
            layout[keyPath: key] = CGRect(
                x: min(max(character.midX - size.width / 2, visible.minX), visible.maxX - size.width),
                y: y, width: size.width, height: size.height)
            edge = flipped ? y : y + size.height
            stack.append(key)
        }
        // The balloon is always next to the character, so nothing comes between the tail and her.
        if let balloon { stacked(balloon, into: \.balloon) }
        if let notices { stacked(notices, into: \.notices) }
        // A stack that runs off the screen moves back as a whole, so its panels never pile on each other; it may then
        // cover the character, which is better than covering itself.
        let excess = flipped ? visible.minY - edge : edge - visible.maxY
        if excess > 0 {
            for key in stack { layout[keyPath: key]?.origin.y += flipped ? excess : -excess }
        }

        if let rect = layout.balloon {
            layout.tailX = min(max(character.midX - rect.minX, tailInset), max(tailInset, rect.width - tailInset))
        }
        return layout
    }

    /// The character's frame for its art. It stays exactly where the owner put it, even partly off the visible area;
    /// only a new size moves it, keeping its feet in place and bringing it onto the screen.
    public static func characterFrame(_ frame: CGRect, art: CGSize, visible: CGRect) -> CGRect {
        frame.size == art ? frame : resized(frame, to: art, within: visible)
    }

    /// The frame at a new size with the same bottom center (the character's feet), kept on the screen.
    public static func resized(_ frame: CGRect, to size: CGSize, within visible: CGRect) -> CGRect {
        clamp(CGRect(x: frame.midX - size.width / 2, y: frame.minY, width: size.width, height: size.height), into: visible)
    }

    /// Moves the rect onto the screen, keeping its size.
    public static func clamp(_ rect: CGRect, into visible: CGRect) -> CGRect {
        var result = rect
        result.origin.x = min(max(rect.minX, visible.minX), visible.maxX - rect.width)
        result.origin.y = min(max(rect.minY, visible.minY), visible.maxY - rect.height)
        return result
    }
}

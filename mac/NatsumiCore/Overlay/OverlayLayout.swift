import CoreGraphics

/// Where the balloon's tail points.
public enum BalloonTail: Equatable, Sendable {
    /// The balloon is above the character.
    case down
    /// The balloon had no room above and is below the character.
    case up
}

/// Where the panels around the character go, in screen coordinates (origin at the bottom left).
/// The balloon goes above the character and the input field below; whichever does not fit moves to the other side,
/// with the input field nearest the character. The history opens beside the character.
public struct OverlayLayout: Equatable, Sendable {
    public static let gap: CGFloat = 4
    /// How far the tail stays from the balloon's sides.
    public static let tailInset: CGFloat = 18

    public var balloon: CGRect?
    public var tail: BalloonTail = .down
    /// The tail's position from the balloon's left side.
    public var tailX: CGFloat = 0
    public var input: CGRect?
    public var history: CGRect?
    public var notices: CGRect?

    public static func make(
        visible: CGRect, character: CGRect, balloon: CGSize?, input: CGSize?, history: CGSize?, notices: CGSize? = nil
    ) -> OverlayLayout {
        var layout = OverlayLayout()
        var above = character.maxY + gap
        var below = character.minY - gap

        if let input {
            let x = centered(input.width, on: character, within: visible)
            if below - input.height >= visible.minY {
                layout.input = CGRect(x: x, y: below - input.height, width: input.width, height: input.height)
                below -= input.height + gap
            } else {
                layout.input = CGRect(x: x, y: min(above, visible.maxY - input.height), width: input.width, height: input.height)
                above += input.height + gap
            }
        }

        if let balloon {
            let x = centered(balloon.width, on: character, within: visible)
            if above + balloon.height <= visible.maxY || below - balloon.height < visible.minY {
                layout.balloon = CGRect(x: x, y: min(above, visible.maxY - balloon.height), width: balloon.width, height: balloon.height)
                layout.tail = .down
            } else {
                layout.balloon = CGRect(x: x, y: below - balloon.height, width: balloon.width, height: balloon.height)
                layout.tail = .up
            }
            let tailMax = max(tailInset, balloon.width - tailInset)
            layout.tailX = min(max(character.midX - x, tailInset), tailMax)
        }

        if let history {
            var x = character.minX - gap - history.width
            if x < visible.minX { x = min(character.maxX + gap, visible.maxX - history.width) }
            let top = min(max(character.maxY, visible.minY + history.height), visible.maxY)
            layout.history = CGRect(x: x, y: top - history.height, width: history.width, height: history.height)
        }

        if let notices {
            layout.notices = placeNotices(
                notices, character: character, visible: visible, avoiding: [layout.balloon, layout.input].compactMap { $0 })
        }
        return layout
    }

    /// The notice bundle goes beside the character with its top at the character's top: on the right, or on the left
    /// when it does not fit, and further out past the balloon and the input field when it would cover them.
    private static func placeNotices(_ size: CGSize, character: CGRect, visible: CGRect, avoiding others: [CGRect]) -> CGRect {
        let y = min(max(character.maxY - size.height, visible.minY), visible.maxY - size.height)
        var right = CGRect(x: character.maxX + gap, y: y, width: size.width, height: size.height)
        while let hit = others.first(where: { $0.intersects(right) }) { right.origin.x = hit.maxX + gap }
        if right.maxX <= visible.maxX { return right }

        var left = CGRect(x: character.minX - gap - size.width, y: y, width: size.width, height: size.height)
        while let hit = others.first(where: { $0.intersects(left) }) { left.origin.x = hit.minX - gap - size.width }
        if left.minX >= visible.minX { return left }
        return clamp(right, into: visible)
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

    private static func centered(_ width: CGFloat, on character: CGRect, within visible: CGRect) -> CGFloat {
        min(max(character.midX - width / 2, visible.minX), visible.maxX - width)
    }
}

import CoreGraphics
import Foundation

/// Which way the character faces while she runs.
public enum RunDirection: Equatable, Sendable {
    case left
    case right
}

/// What the character is doing, apart from her face. It takes the place of the animation her expression would
/// otherwise be drawn with, so that she runs while she moves whatever face she is wearing.
public enum CharacterMotion: Equatable, Sendable {
    case still
    case running(RunDirection)
}

/// How the character moves from one place to another.
public enum CharacterRun {
    /// How long a run takes. The panels grow and shrink over the same time and with the same curve, so that nothing
    /// in the column drifts apart from her while she goes.
    public static let duration: TimeInterval = 0.25
    /// A sideways movement smaller than this does not turn her round: straight up and straight down keep the way she
    /// was already facing, rather than flipping her on a pixel of sideways noise.
    public static let sidewaysThreshold: CGFloat = 2

    public static func facing(from: CGPoint, to: CGPoint, keeping last: RunDirection) -> RunDirection {
        let dx = to.x - from.x
        if dx > sidewaysThreshold { return .right }
        if dx < -sidewaysThreshold { return .left }
        return last
    }
}

/// Stepping out of the way of a pointer that is on its way to whatever is underneath her.
///
/// The thresholds are here, and not in the app, so that what counts as near, how long the pointer has to stay there
/// and how far away she has to get can be tested without a screen.
public enum PointerDodge {
    /// How far around her counts as the pointer being on its way to her.
    public static let margin: CGFloat = 28
    /// How far the pointer has to get before she comes back. It is wider than `margin` on purpose: with one
    /// threshold she would leave and return over and over.
    public static let awayMargin: CGFloat = 96
    /// How long the pointer has to stay near before she goes. A click that lands sooner still reaches her.
    public static let linger: TimeInterval = 0.4
    /// How long the pointer has to stay clear before she comes back.
    public static let settle: TimeInterval = 0.7
    /// The pointer is looked at no more often than this. Mouse moves arrive far faster than anything here needs.
    public static let sampleInterval: TimeInterval = 0.04
    /// How far the place she goes to has to be from the pointer. Anywhere closer is not worth the run, and running
    /// to a place the pointer is already at is how a to-and-fro starts.
    public static let clearance: CGFloat = 96
    /// How close to the side of the screen counts as being against it.
    public static let edgeTolerance: CGFloat = 2

    public static func isNear(_ pointer: CGPoint, of rect: CGRect, textScale: Double) -> Bool {
        rect.insetBy(dx: -margin * textScale, dy: -margin * textScale).contains(pointer)
    }

    public static func isAway(_ pointer: CGPoint, of rect: CGRect, textScale: Double) -> Bool {
        !rect.insetBy(dx: -awayMargin * textScale, dy: -awayMargin * textScale).contains(pointer)
    }

    /// Where she goes to leave the pointer room: the side of the screen that is furthest from it, or, when she is
    /// against a side already, along that side away from the pointer. nil when nowhere is far enough to be worth it.
    public static func target(character: CGRect, pointer: CGPoint, visible: CGRect) -> CGPoint? {
        let againstASide = character.minX - visible.minX <= edgeTolerance
            || visible.maxX - character.maxX <= edgeTolerance
        let candidates: [CGPoint] = againstASide
            ? [
                CGPoint(x: character.minX, y: visible.minY),
                CGPoint(x: character.minX, y: visible.maxY - character.height),
            ]
            : [
                CGPoint(x: visible.minX, y: character.minY),
                CGPoint(x: visible.maxX - character.width, y: character.minY),
            ]
        func room(_ origin: CGPoint) -> CGFloat {
            distance(from: pointer, to: CGRect(origin: origin, size: character.size))
        }
        guard let best = candidates.max(by: { room($0) < room($1) }), room(best) >= clearance,
              best != character.origin
        else { return nil }
        return best
    }

    /// How far a point is from a rectangle; 0 when it is inside it.
    static func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
}

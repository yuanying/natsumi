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

/// Opening and folding a card. The panel's frame and what is drawn in it move over this time and this curve, so
/// that the outline never runs ahead of the words. It is not a run and does not depend on any distance.
public enum CardAnimation {
    public static let duration: TimeInterval = 0.25
}

/// How the character moves from one place to another.
public enum CharacterRun {
    /// How fast she runs, in points a second. The time comes from the distance so that every move has the same
    /// footfall: a short step aside takes long enough for the running art to be seen, and a long run across the
    /// screen does not crawl.
    public static let speed: CGFloat = 220
    /// However short or long the way is, a run lasts between these.
    public static let shortest: TimeInterval = 0.5
    public static let longest: TimeInterval = 1.3
    /// A sideways movement smaller than this does not turn her round: straight up and straight down keep the way she
    /// was already facing, rather than flipping her on a pixel of sideways noise.
    public static let sidewaysThreshold: CGFloat = 2

    public static func duration(from: CGPoint, to: CGPoint) -> TimeInterval {
        let dx = to.x - from.x, dy = to.y - from.y
        let distance = (dx * dx + dy * dy).squareRoot()
        return min(max(TimeInterval(distance / speed), shortest), longest)
    }

    public static func facing(from: CGPoint, to: CGPoint, keeping last: RunDirection) -> RunDirection {
        let dx = to.x - from.x
        if dx > sidewaysThreshold { return .right }
        if dx < -sidewaysThreshold { return .left }
        return last
    }

    /// The curve a run follows: the ease-in-ease-out cubic Bézier, with its control points at (0.42, 0) and
    /// (0.58, 1). The stage animates with the same one, so that where this says she is, she is.
    public static let curve: (CGFloat, CGFloat, CGFloat, CGFloat) = (0.42, 0, 0.58, 1)

    /// How far along the way she is at this share of the time, from 0 to 1.
    public static func progress(at time: CGFloat) -> CGFloat {
        guard time > 0 else { return 0 }
        guard time < 1 else { return 1 }
        let u = time
        let (x1, y1, x2, y2) = curve
        func bezier(_ t: CGFloat, _ p1: CGFloat, _ p2: CGFloat) -> CGFloat {
            let s = 1 - t
            return 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t
        }
        // The curve is given by its parameter, not by time; the parameter for this time is found by bisection.
        var low: CGFloat = 0, high: CGFloat = 1
        for _ in 0..<40 {
            let mid = (low + high) / 2
            if bezier(mid, x1, x2) < u { low = mid } else { high = mid }
        }
        return bezier((low + high) / 2, y1, y2)
    }

    /// Where she is this long into a run, so that a run stopped part way leaves her exactly where she was seen.
    public static func place(from: CGPoint, to: CGPoint, duration: TimeInterval, elapsed: TimeInterval) -> CGPoint {
        guard duration > 0, elapsed < duration else { return to }
        guard elapsed > 0 else { return from }
        let p = progress(at: CGFloat(elapsed / duration))
        return CGPoint(x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p)
    }
}

/// Where she stands between launches.
public enum CharacterPlace {
    /// The place an earlier version saved as her window's frame ("x y width height screenX screenY …", as AppKit
    /// writes a window frame to the defaults), so that she does not move on the first launch of this one.
    public static func legacyOrigin(_ frameString: String) -> CGPoint? {
        let numbers = frameString.split(separator: " ").compactMap { Double($0) }
        guard numbers.count >= 4 else { return nil }
        return CGPoint(x: numbers[0], y: numbers[1])
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
    /// How long the pointer has to stay near before she goes. A click that lands sooner still reaches her, so this
    /// is long enough to go to her and press deliberately.
    public static let linger: TimeInterval = 1
    /// How long the pointer has to stay clear before she comes back.
    public static let settle: TimeInterval = 0.7
    /// The pointer is looked at no more often than this. Mouse moves arrive far faster than anything here needs.
    public static let sampleInterval: TimeInterval = 0.04
    /// How far the place she goes to has to end up from the pointer. She only has to be out of its way, not far
    /// off; running to a place the pointer is already at is how a to-and-fro starts.
    public static let clearance: CGFloat = 60

    /// How far she steps aside: her own size and the margin on either side of it, so she clears the pointer and no
    /// more. Going to the edge of the screen puts her further away than anything asks for.
    public static func hop(for size: CGSize) -> CGSize {
        CGSize(width: size.width + margin * 2, height: size.height + margin * 2)
    }

    public static func isNear(_ pointer: CGPoint, of rect: CGRect, textScale: Double) -> Bool {
        rect.insetBy(dx: -margin * textScale, dy: -margin * textScale).contains(pointer)
    }

    public static func isAway(_ pointer: CGPoint, of rect: CGRect, textScale: Double) -> Bool {
        !rect.insetBy(dx: -awayMargin * textScale, dy: -awayMargin * textScale).contains(pointer)
    }

    /// Where she steps aside to: one hop away from the pointer, sideways first. When the screen runs out that way
    /// she tries the other side, and then up or down. nil when nowhere gets her out of the pointer's way, which is
    /// also what keeps her from a pointless run on a small screen.
    public static func target(character: CGRect, pointer: CGPoint, visible: CGRect) -> CGPoint? {
        let hop = hop(for: character.size)
        let sideways: CGFloat = pointer.x <= character.midX ? 1 : -1
        let upwards: CGFloat = pointer.y <= character.midY ? 1 : -1
        let candidates = [
            CGPoint(x: character.minX + hop.width * sideways, y: character.minY),
            CGPoint(x: character.minX - hop.width * sideways, y: character.minY),
            CGPoint(x: character.minX, y: character.minY + hop.height * upwards),
            CGPoint(x: character.minX, y: character.minY - hop.height * upwards),
        ]
        for origin in candidates {
            let placed = OverlayLayout.clamp(CGRect(origin: origin, size: character.size), into: visible)
            guard placed.origin != character.origin, distance(from: pointer, to: placed) >= clearance else { continue }
            return placed.origin
        }
        return nil
    }

    /// How far a point is from a rectangle; 0 when it is inside it.
    static func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
}

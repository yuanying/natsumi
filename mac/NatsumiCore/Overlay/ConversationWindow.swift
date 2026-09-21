import CoreGraphics
import Foundation

/// The conversation window as it is kept between launches (ADR 0021): where it was left, how wide it is, how tall
/// it is folded (the input field alone) and unfolded (the history above it), and which of the two it was.
///
/// The width is shared by both states, so that unfolding changes one number; the heights are remembered
/// separately, so that a folded window can be made tall enough for several lines without the history ever
/// opening to that little. nil for the origin means the window has never been on the screen: the first time it
/// opens right under the character.
public struct ConversationWindow: Equatable, Sendable {
    public static let minWidth: CGFloat = 260
    public static let minFoldedHeight: CGFloat = 120
    public static let minUnfoldedHeight: CGFloat = 260
    public static let `default` = ConversationWindow(
        origin: nil, width: 320, foldedHeight: 140, unfoldedHeight: 480, showsHistory: false)

    public var origin: CGPoint?
    public let width: CGFloat
    public let foldedHeight: CGFloat
    public let unfoldedHeight: CGFloat
    public var showsHistory: Bool
    /// While the history is unfolded: where the window stood folded, and the frame unfolding gave it. Folding
    /// goes back to the first for as long as the window still has the second; once the owner has moved or
    /// resized it, it folds about the middle of where it is instead.
    public var foldedOrigin: CGPoint?
    public var unfoldedFrame: CGRect?

    public init(origin: CGPoint?, width: CGFloat, foldedHeight: CGFloat, unfoldedHeight: CGFloat, showsHistory: Bool) {
        self.origin = origin.flatMap { $0.x.isFinite && $0.y.isFinite ? $0 : nil }
        self.width = width.isFinite ? max(width, Self.minWidth) : Self.default.width
        self.foldedHeight = foldedHeight.isFinite ? max(foldedHeight, Self.minFoldedHeight) : Self.default.foldedHeight
        self.unfoldedHeight =
            unfoldedHeight.isFinite ? max(unfoldedHeight, Self.minUnfoldedHeight) : Self.default.unfoldedHeight
        self.showsHistory = showsHistory
    }

    /// The height it has in the state it is in.
    public var height: CGFloat { showsHistory ? unfoldedHeight : foldedHeight }
    public var size: CGSize { CGSize(width: width, height: height) }
    /// Where it is, once it has been placed.
    public var frame: CGRect? { origin.map { CGRect(origin: $0, size: size) } }

    /// The window as the owner left it: the frame is what the screen has, and the height goes to the state it is in.
    public func left(at frame: CGRect) -> ConversationWindow {
        var left = ConversationWindow(
            origin: frame.origin, width: frame.width,
            foldedHeight: showsHistory ? foldedHeight : frame.height,
            unfoldedHeight: showsHistory ? frame.height : unfoldedHeight,
            showsHistory: showsHistory)
        left.foldedOrigin = foldedOrigin
        left.unfoldedFrame = unfoldedFrame
        return left
    }

    /// The window with the history unfolded or folded. It unfolds about the middle of where it is, and folds back
    /// to where it stood before, unless it has been moved or resized since, when it folds about the middle too.
    /// What the screen cannot hold is cut, and the height remembered is the one it has.
    public func togglingHistory(within visible: CGRect) -> ConversationWindow {
        var toggled = self
        toggled.showsHistory.toggle()
        guard let frame else { return toggled }
        if toggled.showsHistory {
            let grown = ConversationPlacement.grown(frame, to: toggled.height, within: visible)
            toggled = toggled.left(at: grown)
            toggled.foldedOrigin = frame.origin
            toggled.unfoldedFrame = grown
            return toggled
        }
        if frame == unfoldedFrame, let foldedOrigin {
            toggled.origin = OverlayLayout.clamp(CGRect(origin: foldedOrigin, size: toggled.size), into: visible).origin
        } else {
            toggled = toggled.left(at: ConversationPlacement.grown(frame, to: toggled.height, within: visible))
        }
        toggled.foldedOrigin = nil
        toggled.unfoldedFrame = nil
        return toggled
    }
}

/// Where the conversation window goes. It is not in the column and does not follow the character (ADR 0021).
public enum ConversationPlacement {
    /// The first place it opens: right under the character, on the screen.
    public static func first(under character: CGRect, size: CGSize, spacing: CGFloat, visible: CGRect) -> CGRect {
        let frame = CGRect(
            x: character.midX - size.width / 2, y: character.minY - spacing - size.height,
            width: size.width, height: size.height)
        return OverlayLayout.clamp(frame, into: visible)
    }

    /// The frame at a new height, grown or shrunk evenly up and down about the middle of the old one. What does
    /// not fit on one side goes to the other; what fits on neither is cut to the visible area.
    public static func grown(_ frame: CGRect, to height: CGFloat, within visible: CGRect) -> CGRect {
        let height = min(height, visible.height)
        let grown = CGRect(x: frame.minX, y: frame.midY - height / 2, width: frame.width, height: height)
        return OverlayLayout.clamp(grown, into: visible)
    }
}

import CoreGraphics
import Foundation

/// The part of a message that fits in a balloon. The whole text is in the history.
public struct BalloonText: Equatable, Sendable {
    public static let maxCharacters = 120
    public static let maxLines = 5
    /// The most an opened card shows. Beyond this the column cannot fit on any screen, and the rest stays in the
    /// history; the layout reduces it further when the screen is smaller.
    public static let expandedMaxLines = 40

    public let text: String
    public let isTruncated: Bool

    public init(text: String, isTruncated: Bool) {
        self.text = text
        self.isTruncated = isTruncated
    }

    /// The whole text, trimmed; nothing is cut here. How many lines of it are shown is the layout's to decide.
    public static func whole(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The lines the text is written in. A long line wraps into more than one on the screen, so this is the least
    /// the card needs, not the most.
    public static func lineCount(_ text: String) -> Int {
        whole(text).split(separator: "\n", omittingEmptySubsequences: false).count
    }

    public static func preview(_ text: String) -> BalloonText {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
        var truncated = false
        if lines.count > maxLines {
            lines = Array(lines.prefix(maxLines))
            truncated = true
        }
        var shown = lines.joined(separator: "\n")
        if shown.count > maxCharacters {
            shown = String(shown.prefix(maxCharacters))
            truncated = true
        }
        return BalloonText(text: truncated ? shown + "…" : shown, isTruncated: truncated)
    }
}

/// What the balloon says when there is no unread reply: the owner's message is not accepted yet, or natsumi has
/// something to handle.
public enum BalloonIndicator: Equatable, Sendable {
    case receiving
    case thinking
}

/// One card in the notice bundle.
public enum NoticeCard: Equatable, Sendable {
    case notice(ShownMessage)
    /// Notices older than the conversation the client has. Their text is not available, so they share one card.
    case older(ids: [String])
}

/// Unchecked notices stacked apart from the replies: the oldest in front, a few edges behind it, and how many
/// there are.
public struct NoticeStack: Equatable, Sendable {
    /// Edges drawn behind the front card at most; the rest is only counted.
    public static let maxBehind = 2

    public let front: NoticeCard
    /// The notices the front card checks.
    public let frontIds: [String]
    /// All unchecked notices.
    public let count: Int
    /// Cards in the bundle.
    public let cards: Int

    public init(front: NoticeCard, frontIds: [String], count: Int, cards: Int) {
        self.front = front
        self.frontIds = frontIds
        self.count = count
        self.cards = cards
    }

    public var behind: Int { min(max(cards - 1, 0), Self.maxBehind) }
    /// Notices after the front card.
    public var more: Int { max(count - frontIds.count, 0) }
}

/// The badge with the number of unchecked notices, at the top right of the character and sized with it.
public enum CharacterBadge {
    static let baseDiameter: CGFloat = 22
    /// Small characters keep a badge that can be read and clicked.
    static let minimumDiameter: CGFloat = 14

    /// The badge in the character's view, with the origin at the top left.
    public static func frame(for scale: CharacterScale) -> CGRect {
        let diameter = max(minimumDiameter, baseDiameter * scale.value)
        return CGRect(x: scale.artSize.width - diameter, y: 0, width: diameter, height: diameter)
    }
}

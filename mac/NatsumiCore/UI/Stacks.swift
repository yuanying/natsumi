import CoreGraphics
import Foundation

/// The part of a message that fits in a balloon. The whole text is in the history.
public struct BalloonText: Equatable, Sendable {
    public static let maxCharacters = 120
    public static let maxLines = 5

    public let text: String
    public let isTruncated: Bool

    public init(text: String, isTruncated: Bool) {
        self.text = text
        self.isTruncated = isTruncated
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

/// Unread replies stacked in the balloon: the oldest in front, a few edges behind it, and how many there are.
public struct ReplyStack: Equatable, Sendable {
    /// Edges drawn behind the front reply at most; the rest is only counted.
    public static let maxBehind = 2

    public let front: ShownMessage
    /// All unread replies, including ones older than the conversation the client has.
    public let count: Int

    public init(front: ShownMessage, count: Int) {
        self.front = front
        self.count = count
    }

    public var behind: Int { min(max(count - 1, 0), Self.maxBehind) }
    /// Replies after the front one.
    public var more: Int { max(count - 1, 0) }
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

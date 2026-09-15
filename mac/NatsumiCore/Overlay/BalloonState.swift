import Foundation

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

/// What the speech balloon above the character says.
public enum BalloonContent: Equatable, Sendable {
    /// The owner sent something the server has not accepted yet.
    case receiving
    /// natsumi has owner messages still to handle.
    case thinking
    /// natsumi's replies the owner has not read.
    case replies(ReplyStack)
}

/// The balloon: natsumi's unread replies, oldest first, or that she is receiving or thinking when there are none.
/// Replies stay until the owner reads them; closing "receiving" or "thinking" hides it until the balloon would say
/// something else.
public struct BalloonState: Equatable, Sendable {
    /// `nil` when the balloon is hidden.
    public private(set) var content: BalloonContent?
    /// Replies are shown while natsumi is still receiving or thinking.
    public private(set) var isBusy = false

    private var candidate: BalloonContent?
    private var dismissedIndicator: BalloonContent?

    public init() {}

    public mutating func update(with conversation: ConversationState) {
        let busy = conversation.outbox.contains { $0.status == .sending } ? BalloonContent.receiving
            : conversation.isThinking ? .thinking : nil
        if let front = conversation.unreadReplies.first {
            candidate = .replies(ReplyStack(front: front, count: conversation.unreadReplyCount))
            isBusy = busy != nil
        } else {
            candidate = busy
            isBusy = false
        }
        if candidate != dismissedIndicator { dismissedIndicator = nil }
        refresh()
    }

    /// Hides "receiving" or "thinking". Replies are closed by reading them.
    public mutating func dismiss() {
        switch candidate {
        case .receiving, .thinking: dismissedIndicator = candidate
        case .replies, nil: break
        }
        refresh()
    }

    private mutating func refresh() {
        if let indicator = candidate, indicator == dismissedIndicator {
            content = nil
        } else {
            content = candidate
        }
    }
}

/// The part of a message that fits in the balloon. The whole text is in the history.
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

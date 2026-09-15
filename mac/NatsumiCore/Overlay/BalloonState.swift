import Foundation

/// What the speech balloon above the character says.
public enum BalloonContent: Equatable, Sendable {
    /// The owner sent something the server has not accepted yet.
    case receiving
    /// natsumi is thinking or has messages still to handle.
    case thinking
    /// natsumi's last reply or notice.
    case message(ShownMessage)
}

/// The balloon: natsumi's last word, or that she is receiving or thinking. Closing it hides what it says until it says
/// something else; a closed message stays hidden until natsumi says a different one.
public struct BalloonState: Equatable, Sendable {
    /// `nil` when the balloon is hidden.
    public private(set) var content: BalloonContent?
    /// The message arrived while connected, rather than coming back in a snapshot.
    public private(set) var isNew = false

    private var candidate: BalloonContent?
    private var dismissedMessageId: String?
    private var dismissedIndicator: BalloonContent?
    private var lastMessageId: String?
    private var snapshotGeneration = 0

    public init() {}

    public mutating func update(with conversation: ConversationState) {
        let latest = conversation.messages.last { $0.role == .natsumi }
        let fromSnapshot = conversation.snapshotGeneration != snapshotGeneration
        if latest?.messageId != lastMessageId {
            isNew = latest != nil && !fromSnapshot
            if latest?.messageId != dismissedMessageId { dismissedMessageId = nil }
        } else if fromSnapshot {
            isNew = false
        }
        lastMessageId = latest?.messageId
        snapshotGeneration = conversation.snapshotGeneration

        if conversation.outbox.contains(where: { $0.status == .sending }) {
            candidate = .receiving
        } else if conversation.isThinking {
            candidate = .thinking
        } else {
            candidate = latest.map { .message($0) }
        }
        if candidate != dismissedIndicator { dismissedIndicator = nil }
        refresh()
    }

    public mutating func dismiss() {
        switch candidate {
        case .message(let message): dismissedMessageId = message.messageId
        case .receiving, .thinking: dismissedIndicator = candidate
        case nil: break
        }
        refresh()
    }

    private mutating func refresh() {
        switch candidate {
        case .message(let message) where message.messageId == dismissedMessageId:
            content = nil
        case let indicator? where indicator == dismissedIndicator:
            content = nil
        default:
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

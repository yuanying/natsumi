import Foundation

/// How far the conversation window has been read: the owner saw a reply when its row was in sight in the unfolded
/// history of the key window (ADR 0022). The read position is one cursor, so what is before it is read with it.
public enum HistoryReading {
    /// The last reply among the rows in sight, when it is still unread; nil when there is nothing to read.
    public static func target(_ conversation: ConversationState, visible: Set<String>) -> String? {
        guard let last = conversation.messages.last(where: { $0.kind == .reply && visible.contains($0.messageId) }),
              conversation.isUnread(last)
        else { return nil }
        return last.messageId
    }
}

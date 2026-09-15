import CoreGraphics
import Foundation

/// One card in the notice bundle.
public enum NoticeCard: Equatable, Sendable {
    case notice(ShownMessage)
    /// Notices older than the conversation the client has. Their text is not available, so they share one card.
    case older(ids: [String])
}

/// Unchecked notices stacked apart from the replies: the oldest in front, a few edges behind it, and how many there are.
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

/// The yellow bundle of unchecked notices and the badge on the character. The badge hides and shows the bundle;
/// hiding checks nothing, and a new notice shows the bundle again.
public struct NoticeBundleState: Equatable, Sendable {
    public private(set) var stack: NoticeStack?
    public private(set) var isHidden = false

    private var seen: Set<String> = []

    public init() {}

    public var isShown: Bool { stack != nil && !isHidden }
    public var badgeCount: Int { stack?.count ?? 0 }

    public mutating func update(with conversation: ConversationState) {
        let ids = conversation.unacknowledgedNotificationIds
        if ids.contains(where: { !seen.contains($0) }) { isHidden = false }
        seen.formUnion(ids)

        let byId = Dictionary(conversation.messages.map { ($0.messageId, $0) }, uniquingKeysWith: { first, _ in first })
        // Notices missing from the messages are older than all of them, so they come first.
        let older = ids.prefix { byId[$0] == nil }
        let listed = ids.dropFirst(older.count).compactMap { byId[$0] }
        let cards = (older.isEmpty ? 0 : 1) + listed.count
        if !older.isEmpty {
            stack = NoticeStack(front: .older(ids: Array(older)), frontIds: Array(older), count: ids.count, cards: cards)
        } else if let first = listed.first {
            stack = NoticeStack(front: .notice(first), frontIds: [first.messageId], count: ids.count, cards: cards)
        } else {
            stack = nil
        }
        if stack == nil { isHidden = false }
    }

    /// The badge was clicked.
    public mutating func toggle() {
        guard stack != nil else { return }
        isHidden.toggle()
    }
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

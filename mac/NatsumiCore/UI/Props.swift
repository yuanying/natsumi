import CoreGraphics
import Foundation

/// What the layout decided about the column, and the widest a panel in it may be. The panels are measured with it
/// and then drawn with it, so it is an input of the derivation, not a part of the state.
public struct ColumnPlacement: Equatable, Sendable {
    public var tail: BalloonTail
    /// The tail's position from the balloon's left side.
    public var tailX: CGFloat
    public var budget: StackBudget
    /// The input field's width, which every panel in the column keeps to.
    public var width: CGFloat

    public init(
        tail: BalloonTail = .down, tailX: CGFloat = 40, budget: StackBudget = .full,
        width: CGFloat = InputBoxSize.default.width
    ) {
        self.tail = tail
        self.tailX = tailX
        self.budget = budget
        self.width = width
    }
}

/// A button the owner is offered, with the event it raises.
public struct ActionProps: Equatable, Sendable {
    public var title: String
    public var event: UIEvent

    public init(title: String, event: UIEvent) {
        self.title = title
        self.event = event
    }
}

/// The connection and what to do about it.
public struct StatusProps: Equatable, Sendable {
    public var text: String
    public var action: ActionProps?

    public init(text: String, action: ActionProps?) {
        self.text = text
        self.action = action
    }
}

public struct BadgeProps: Equatable, Sendable {
    public var count: Int
    /// Where the badge sits in the character's view, with the origin at the top left.
    public var frame: CGRect
    public var help: String

    public init(count: Int, frame: CGRect, help: String) {
        self.count = count
        self.frame = frame
        self.help = help
    }
}

public struct CharacterProps: Equatable, Sendable {
    public var scale: CharacterScale
    public var avatar: AvatarArt
    public var expression: Expression
    /// The small grey mark and what it says; nil while connected.
    public var disconnectedHelp: String?
    public var badge: BadgeProps?

    public init(
        scale: CharacterScale, avatar: AvatarArt, expression: Expression, disconnectedHelp: String?, badge: BadgeProps?
    ) {
        self.scale = scale
        self.avatar = avatar
        self.expression = expression
        self.disconnectedHelp = disconnectedHelp
        self.badge = badge
    }
}

/// The reply at the front of the balloon.
public struct ReplyProps: Equatable, Sendable {
    public var text: String
    public var lineLimit: Int
    /// "続きは履歴で": the text is cut, or the column had to show fewer lines.
    public var showsHistoryLink: Bool
    /// "あと N 件".
    public var more: Int
    public var help: String

    public init(text: String, lineLimit: Int, showsHistoryLink: Bool, more: Int, help: String) {
        self.text = text
        self.lineLimit = lineLimit
        self.showsHistoryLink = showsHistoryLink
        self.more = more
        self.help = help
    }
}

public struct BalloonProps: Equatable, Sendable {
    public enum Body: Equatable, Sendable {
        /// The owner sent something the server has not accepted yet.
        case receiving
        /// natsumi has owner messages still to handle.
        case thinking
        case reply(ReplyProps)
    }

    public var body: Body
    /// The small spinner beside an unread reply while natsumi is still working.
    public var isBusy: Bool
    /// Replies drawn as edges behind the front one.
    public var edges: Int
    public var tail: BalloonTail
    public var tailX: CGFloat
    public var width: CGFloat
    public var textScale: Double
    public var closeHelp: String

    public init(
        body: Body, isBusy: Bool, edges: Int, tail: BalloonTail, tailX: CGFloat, width: CGFloat, textScale: Double,
        closeHelp: String
    ) {
        self.body = body
        self.isBusy = isBusy
        self.edges = edges
        self.tail = tail
        self.tailX = tailX
        self.width = width
        self.textScale = textScale
        self.closeHelp = closeHelp
    }
}

public struct NoticeBundleProps: Equatable, Sendable {
    public var text: String
    public var lineLimit: Int
    public var showsHistoryLink: Bool
    public var more: Int
    public var help: String
    public var edges: Int
    /// Cards behind go away from the character: up in the upright column, down when it is flipped.
    public var edgesUpward: Bool
    public var width: CGFloat
    public var textScale: Double

    public init(
        text: String, lineLimit: Int, showsHistoryLink: Bool, more: Int, help: String, edges: Int, edgesUpward: Bool,
        width: CGFloat, textScale: Double
    ) {
        self.text = text
        self.lineLimit = lineLimit
        self.showsHistoryLink = showsHistoryLink
        self.more = more
        self.help = help
        self.edges = edges
        self.edgesUpward = edgesUpward
        self.width = width
        self.textScale = textScale
    }
}

/// A message the owner sent that could not be recorded.
public struct FailureProps: Equatable, Sendable, Identifiable {
    public var requestId: String
    public var text: String

    public init(requestId: String, text: String) {
        self.requestId = requestId
        self.text = text
    }

    public var id: String { requestId }
}

public struct InputProps: Equatable, Sendable {
    public var boxSize: InputBoxSize
    /// How tall the text is, so that the box can grow with it.
    public var measuredTextHeight: CGFloat
    public var textScale: Double
    public var status: StatusProps?
    public var failures: [FailureProps]

    public init(
        boxSize: InputBoxSize, measuredTextHeight: CGFloat, textScale: Double, status: StatusProps?,
        failures: [FailureProps]
    ) {
        self.boxSize = boxSize
        self.measuredTextHeight = measuredTextHeight
        self.textScale = textScale
        self.status = status
        self.failures = failures
    }
}

public struct HistoryRowProps: Equatable, Sendable, Identifiable {
    public var messageId: String
    public var text: String
    public var isOwner: Bool
    public var isNotice: Bool
    /// An unread reply or a notice not checked yet. Opening the history does not read it.
    public var isUnread: Bool

    public init(messageId: String, text: String, isOwner: Bool, isNotice: Bool, isUnread: Bool) {
        self.messageId = messageId
        self.text = text
        self.isOwner = isOwner
        self.isNotice = isNotice
        self.isUnread = isUnread
    }

    public var id: String { messageId }
}

public struct OutgoingRowProps: Equatable, Sendable, Identifiable {
    public var requestId: String
    public var text: String
    /// nil while it is only waiting to be accepted.
    public var failure: String?

    public init(requestId: String, text: String, failure: String?) {
        self.requestId = requestId
        self.text = text
        self.failure = failure
    }

    public var id: String { requestId }
}

public struct HistoryProps: Equatable, Sendable {
    /// The history always says where the connection stands, even when it is fine.
    public var status: StatusProps
    public var rows: [HistoryRowProps]
    public var outgoing: [OutgoingRowProps]
    public var isThinking: Bool

    public init(status: StatusProps, rows: [HistoryRowProps], outgoing: [OutgoingRowProps], isThinking: Bool) {
        self.status = status
        self.rows = rows
        self.outgoing = outgoing
        self.isThinking = isThinking
    }
}

public struct SettingsProps: Equatable, Sendable {
    public var serverOrigin: String
    /// What the last save of the server said.
    public var message: String?
    public var statusText: String
    public var lastError: String?
    public var canLogin: Bool
    public var canLogout: Bool
    public var scale: CharacterScale
    public var avatarDirectory: String
    public var avatarDescription: String

    public init(
        serverOrigin: String, message: String?, statusText: String, lastError: String?, canLogin: Bool,
        canLogout: Bool, scale: CharacterScale, avatarDirectory: String, avatarDescription: String
    ) {
        self.serverOrigin = serverOrigin
        self.message = message
        self.statusText = statusText
        self.lastError = lastError
        self.canLogin = canLogin
        self.canLogout = canLogout
        self.scale = scale
        self.avatarDirectory = avatarDirectory
        self.avatarDescription = avatarDescription
    }
}

public struct MenuProps: Equatable, Sendable {
    public var statusText: String
    public var canReadAllReplies: Bool
    public var canAcknowledgeAllNotices: Bool
    public var showsLogin: Bool
    public var canLogout: Bool

    public init(
        statusText: String, canReadAllReplies: Bool, canAcknowledgeAllNotices: Bool, showsLogin: Bool, canLogout: Bool
    ) {
        self.statusText = statusText
        self.canReadAllReplies = canReadAllReplies
        self.canAcknowledgeAllNotices = canAcknowledgeAllNotices
        self.showsLogin = showsLogin
        self.canLogout = canLogout
    }
}

/// Everything the tree draws, in one value. A panel that is not there is nil.
public struct RootProps: Equatable, Sendable {
    public var character: CharacterProps
    public var balloon: BalloonProps?
    public var notices: NoticeBundleProps?
    public var input: InputProps?
    public var history: HistoryProps?
    public var settings: SettingsProps
    public var menu: MenuProps
    public var isSettingsOpen: Bool
}

/// The drawing parameters, derived from the mediator's state by pure functions. Nothing else in the app may build
/// them.
public enum UIProps {
    public static func root(_ state: UIState, placement: ColumnPlacement) -> RootProps {
        var placement = placement
        placement.width = state.inputBoxSize.width
        let conversation = state.conversation
        return RootProps(
            character: character(state, stack: noticeStack(conversation)),
            balloon: balloon(
                conversation, dismissed: state.dismissedIndicator, placement: placement, scale: state.characterScale),
            notices: notices(
                conversation, hidden: state.noticesHidden, placement: placement, scale: state.characterScale),
            input: state.isInputOpen
                ? input(
                    conversation, status: state.status, scale: state.characterScale, boxSize: state.inputBoxSize,
                    textHeight: state.inputTextHeight)
                : nil,
            history: state.isHistoryOpen ? history(conversation, status: state.status) : nil,
            settings: settings(state),
            menu: menu(state),
            isSettingsOpen: state.isSettingsOpen)
    }

    // MARK: - What the conversation says

    /// The unread replies, oldest in front; nil when there are none.
    public static func replyStack(_ conversation: ConversationState) -> ReplyStack? {
        guard let front = conversation.unreadReplies.first else { return nil }
        return ReplyStack(front: front, count: conversation.unreadReplyCount)
    }

    /// The unchecked notices, oldest in front; nil when there are none.
    public static func noticeStack(_ conversation: ConversationState) -> NoticeStack? {
        let ids = conversation.unacknowledgedNotificationIds
        let byId = Dictionary(conversation.messages.map { ($0.messageId, $0) }, uniquingKeysWith: { first, _ in first })
        // Notices missing from the messages are older than all of them, so they come first.
        let older = ids.prefix { byId[$0] == nil }
        let listed = ids.dropFirst(older.count).compactMap { byId[$0] }
        let cards = (older.isEmpty ? 0 : 1) + listed.count
        if !older.isEmpty {
            return NoticeStack(front: .older(ids: Array(older)), frontIds: Array(older), count: ids.count, cards: cards)
        }
        guard let first = listed.first else { return nil }
        return NoticeStack(front: .notice(first), frontIds: [first.messageId], count: ids.count, cards: cards)
    }

    /// What the balloon would say if there were no unread reply.
    public static func indicator(_ conversation: ConversationState) -> BalloonIndicator? {
        if conversation.outbox.contains(where: { $0.status == .sending }) { return .receiving }
        return conversation.isThinking ? .thinking : nil
    }

    // MARK: - The panels

    static func character(_ state: UIState, stack: NoticeStack?) -> CharacterProps {
        var badge: BadgeProps?
        if let count = stack?.count, count > 0 {
            let shown = !state.noticesHidden
            badge = BadgeProps(
                count: count, frame: CharacterBadge.frame(for: state.characterScale),
                help: "未確認の知らせ \(count) 件（クリックで\(shown ? "隠す" : "出す")）")
        }
        return CharacterProps(
            scale: state.characterScale, avatar: state.avatar, expression: state.conversation.expression,
            disconnectedHelp: state.status == .connected ? nil : state.status.text, badge: badge)
    }

    public static func balloon(
        _ conversation: ConversationState, dismissed: BalloonIndicator?, placement: ColumnPlacement,
        scale: CharacterScale
    ) -> BalloonProps? {
        let indicator = indicator(conversation)
        func props(body: BalloonProps.Body, isBusy: Bool, edges: Int, closeHelp: String) -> BalloonProps {
            BalloonProps(
                body: body, isBusy: isBusy, edges: edges, tail: placement.tail, tailX: placement.tailX,
                width: placement.width, textScale: scale.textScale, closeHelp: closeHelp)
        }
        if let stack = replyStack(conversation) {
            let preview = BalloonText.preview(stack.front.text)
            let lines = placement.budget.lines
            let reply = ReplyProps(
                text: preview.text, lineLimit: lines,
                showsHistoryLink: preview.isTruncated || lines < BalloonText.maxLines, more: stack.more,
                help: stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる")
            return props(
                body: .reply(reply), isBusy: indicator != nil, edges: min(stack.behind, placement.budget.behind),
                closeHelp: "すべて既読にして閉じる")
        }
        guard let indicator, indicator != dismissed else { return nil }
        return props(
            body: indicator == .receiving ? .receiving : .thinking, isBusy: false, edges: 0, closeHelp: "閉じる")
    }

    public static func notices(
        _ conversation: ConversationState, hidden: Bool, placement: ColumnPlacement, scale: CharacterScale
    ) -> NoticeBundleProps? {
        guard !hidden, let stack = noticeStack(conversation) else { return nil }
        let lines = placement.budget.lines
        let text: String
        let showsHistoryLink: Bool
        let help: String
        switch stack.front {
        case .notice(let message):
            let preview = BalloonText.preview(message.text)
            text = preview.text
            showsHistoryLink = preview.isTruncated || lines < BalloonText.maxLines
            help = stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる"
        case .older(let ids):
            // Their text is older than the history, so there is nowhere to send the owner.
            text = "前の知らせが \(ids.count) 件あります（本文は履歴より前のため出せません）"
            showsHistoryLink = false
            help = "クリックでまとめて確かめる"
        }
        return NoticeBundleProps(
            text: text, lineLimit: lines, showsHistoryLink: showsHistoryLink, more: stack.more, help: help,
            edges: min(stack.behind, placement.budget.behind), edgesUpward: placement.tail == .down,
            width: placement.width, textScale: scale.textScale)
    }

    public static func input(
        _ conversation: ConversationState, status: ConnectionStatus, scale: CharacterScale, boxSize: InputBoxSize,
        textHeight: CGFloat
    ) -> InputProps {
        InputProps(
            boxSize: boxSize, measuredTextHeight: textHeight, textScale: scale.textScale, status: statusRow(status),
            failures: conversation.outbox.compactMap { item in
                switch item.status {
                case .sending: nil
                case .rejected(let code), .unavailable(let code):
                    FailureProps(requestId: item.requestId, text: "「\(item.text)」を送れませんでした（\(code)）")
                }
            })
    }

    public static func history(_ conversation: ConversationState, status: ConnectionStatus) -> HistoryProps {
        HistoryProps(
            status: StatusProps(text: status.text, action: action(for: status)),
            rows: conversation.messages.map { message in
                HistoryRowProps(
                    messageId: message.messageId, text: message.text, isOwner: message.role == .owner,
                    isNotice: message.isNotice, isUnread: conversation.isUnread(message))
            },
            outgoing: conversation.outbox.map { item in
                let failure: String? = switch item.status {
                case .sending: nil
                case .rejected(let code), .unavailable(let code): "送れませんでした（\(code)）"
                }
                return OutgoingRowProps(requestId: item.requestId, text: item.text, failure: failure)
            },
            isThinking: conversation.isThinking)
    }

    static func settings(_ state: UIState) -> SettingsProps {
        SettingsProps(
            serverOrigin: state.serverOrigin ?? "", message: state.settingsMessage, statusText: state.status.text,
            lastError: state.lastError, canLogin: state.status == .needsLogin, canLogout: state.hasSession,
            scale: state.characterScale, avatarDirectory: state.avatarDirectory,
            avatarDescription: state.avatarDescription)
    }

    static func menu(_ state: UIState) -> MenuProps {
        MenuProps(
            statusText: state.status.text, canReadAllReplies: !state.conversation.unreadReplies.isEmpty,
            canAcknowledgeAllNotices: !state.conversation.unacknowledgedNotificationIds.isEmpty,
            showsLogin: state.status == .needsLogin, canLogout: state.hasSession)
    }

    /// The connection and what to do about it. The input field says nothing while the connection is fine; the
    /// history says where it stands either way.
    private static func statusRow(_ status: ConnectionStatus) -> StatusProps? {
        guard status != .connected else { return nil }
        return StatusProps(text: status.text, action: action(for: status))
    }

    /// The one thing the owner can do about the connection as it is.
    private static func action(for status: ConnectionStatus) -> ActionProps? {
        switch status {
        case .needsServer: ActionProps(title: "設定を開く", event: .settingsOpenRequested)
        case .needsLogin: ActionProps(title: "GitHub でログイン", event: .loginRequested)
        case .replaced, .stopped, .unavailable: ActionProps(title: "接続し直す", event: .reconnectRequested)
        default: nil
        }
    }
}

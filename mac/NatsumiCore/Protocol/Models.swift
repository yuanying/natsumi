import Foundation

/// The avatar expressions the server chooses from (client-contract `avatar.expression`).
public enum Expression: String, CaseIterable, Codable, Sendable {
    case neutral, happy, laughing, surprised, thinking, worried, sad, sleepy
}

/// How far the server got with an owner message.
public enum EventState: String, Codable, Sendable {
    case queued, processing, replied
    case noReply = "no-reply"
    case failed

    /// Still waiting for natsumi to handle it.
    public var isPending: Bool { self == .queued || self == .processing }
}

/// A message as the owner sees it: an owner message, a reply, or a notice.
public struct ShownMessage: Codable, Equatable, Identifiable, Sendable {
    public enum Role: String, Codable, Sendable { case owner, natsumi }
    public enum Kind: String, Codable, Sendable { case message, reply, notice }

    public let messageId: String
    public let role: Role
    public let kind: Kind
    public let text: String
    public let createdAt: String
    /// `createdAt`, read once when the message arrives: the history is derived again whenever the rows in sight
    /// change. nil when the server's timestamp cannot be read.
    public let date: Date?
    /// The event of an owner message.
    public let eventId: String?
    /// The event a reply answers.
    public let replyTo: String?
    /// The events a notice is about.
    public let about: [String]?
    /// The feeling natsumi put into one of her lines (ADR 0026). nil on the owner's messages, on her lines from
    /// before the server kept it, and when the value is not one this app knows: all of them read as not known.
    public let expression: Expression?

    public init(
        messageId: String, role: Role, kind: Kind, text: String, createdAt: String,
        eventId: String? = nil, replyTo: String? = nil, about: [String]? = nil, expression: Expression? = nil
    ) {
        self.messageId = messageId
        self.role = role
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.date = parseTimestamp(createdAt)
        self.eventId = eventId
        self.replyTo = replyTo
        self.about = about
        self.expression = expression
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, role, kind, text, createdAt, eventId, replyTo, about, expression
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            messageId: try values.decode(String.self, forKey: .messageId), role: try values.decode(Role.self, forKey: .role),
            kind: try values.decode(Kind.self, forKey: .kind), text: try values.decode(String.self, forKey: .text),
            createdAt: try values.decode(String.self, forKey: .createdAt),
            eventId: try values.decodeIfPresent(String.self, forKey: .eventId),
            replyTo: try values.decodeIfPresent(String.self, forKey: .replyTo),
            about: try values.decodeIfPresent([String].self, forKey: .about),
            // Read as a string first: a feeling added on the server later must not lose the line.
            expression: (try? values.decodeIfPresent(String.self, forKey: .expression)).flatMap { $0 }
                .flatMap(Expression.init(rawValue:)))
    }

    public var id: String { messageId }
    public var isNotice: Bool { kind == .notice }
}

public struct PendingEvent: Codable, Equatable, Sendable {
    public let eventId: String
    public let messageId: String
    public let state: EventState

    public init(eventId: String, messageId: String, state: EventState) {
        self.eventId = eventId
        self.messageId = messageId
        self.state = state
    }
}

/// What the owner has read and checked, as the server keeps it for every device (client-contract「既読と知らせの確認」).
public struct ReadState: Equatable, Sendable {
    /// Replies up to this message are read; nil when nothing is.
    public var readThroughMessageId: String?
    /// Unread replies, counting ones older than the snapshot's messages.
    public var unreadReplyCount: Int
    /// Notices not checked yet, oldest first, including ones older than the snapshot's messages.
    public var unacknowledgedNotificationIds: [String]

    public init(readThroughMessageId: String? = nil, unreadReplyCount: Int = 0, unacknowledgedNotificationIds: [String] = []) {
        self.readThroughMessageId = readThroughMessageId
        self.unreadReplyCount = unreadReplyCount
        self.unacknowledgedNotificationIds = unacknowledgedNotificationIds
    }
}

public struct Snapshot: Equatable, Sendable {
    public let deviceId: String
    public let messages: [ShownMessage]
    public let pendingEvents: [PendingEvent]
    public let expression: Expression
    public let readState: ReadState
    /// Slack posts waiting for the owner, oldest first.
    public let pendingApprovals: [Approval]

    public init(
        deviceId: String, messages: [ShownMessage], pendingEvents: [PendingEvent], expression: Expression,
        readState: ReadState = ReadState(), pendingApprovals: [Approval] = []
    ) {
        self.deviceId = deviceId
        self.messages = messages
        self.pendingEvents = pendingEvents
        self.expression = expression
        self.readState = readState
        self.pendingApprovals = pendingApprovals
    }
}

public struct EventCompletion: Codable, Equatable, Sendable {
    public let eventId: String
    public let messageId: String
    public let status: EventState
    public let reason: String?

    public init(eventId: String, messageId: String, status: EventState, reason: String?) {
        self.eventId = eventId
        self.messageId = messageId
        self.status = status
        self.reason = reason
    }
}

/// `command.accepted`: a recorded `conversation.send`, a `session.sync` that replayed what was missed, the read
/// position after `conversation.read`, the notice `notification.ack` checked, or the state `approval.decide` left an
/// approval in.
public struct CommandAccepted: Decodable, Equatable, Sendable {
    public let messageId: String?
    public let eventId: String?
    public let state: EventState?
    public let deviceId: String?
    public let mode: String?
    public let readThroughMessageId: String?
    public let unreadReplyCount: Int?
    public let notificationId: String?
    public let approvalId: String?
    public let revision: Int?
    /// `state` on an answer to `approval.decide`, which shares the field with the conversation's.
    public let approvalOutcome: ApprovalOutcome?

    public init(
        messageId: String? = nil, eventId: String? = nil, state: EventState? = nil, deviceId: String? = nil, mode: String? = nil,
        readThroughMessageId: String? = nil, unreadReplyCount: Int? = nil, notificationId: String? = nil,
        approvalId: String? = nil, revision: Int? = nil, approvalOutcome: ApprovalOutcome? = nil
    ) {
        self.messageId = messageId
        self.eventId = eventId
        self.state = state
        self.deviceId = deviceId
        self.mode = mode
        self.readThroughMessageId = readThroughMessageId
        self.unreadReplyCount = unreadReplyCount
        self.notificationId = notificationId
        self.approvalId = approvalId
        self.revision = revision
        self.approvalOutcome = approvalOutcome
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, eventId, state, deviceId, mode, readThroughMessageId, unreadReplyCount, notificationId, approvalId, revision
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let state = try values.decodeIfPresent(String.self, forKey: .state)
        self.init(
            messageId: try values.decodeIfPresent(String.self, forKey: .messageId),
            eventId: try values.decodeIfPresent(String.self, forKey: .eventId),
            state: state.flatMap(EventState.init(rawValue:)), deviceId: try values.decodeIfPresent(String.self, forKey: .deviceId),
            mode: try values.decodeIfPresent(String.self, forKey: .mode),
            readThroughMessageId: try values.decodeIfPresent(String.self, forKey: .readThroughMessageId),
            unreadReplyCount: try values.decodeIfPresent(Int.self, forKey: .unreadReplyCount),
            notificationId: try values.decodeIfPresent(String.self, forKey: .notificationId),
            approvalId: try values.decodeIfPresent(String.self, forKey: .approvalId),
            revision: try values.decodeIfPresent(Int.self, forKey: .revision),
            approvalOutcome: state.flatMap(ApprovalOutcome.init(rawValue:)))
    }
}

/// Where an event sits in the server's numbering: process epoch, device stream and sequence.
public struct StreamPosition: Codable, Equatable, Sendable {
    public let epoch: String
    public let streamId: String
    public let seq: Int

    public init(epoch: String, streamId: String, seq: Int) {
        self.epoch = epoch
        self.streamId = streamId
        self.seq = seq
    }
}

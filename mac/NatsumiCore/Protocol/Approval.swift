import Foundation

/// Where a Slack post goes: in the thread of the line it answers, or in the channel itself.
public enum ApprovalPlacement: String, Equatable, Sendable {
    case thread, channel
}

/// Why the post was handed to the owner (client-contract「Slack の投稿の承認」).
public enum ApprovalVerdict: String, Equatable, Sendable {
    /// The dove handed it to the owner.
    case owner
    /// The dove could not judge it.
    case noVerdict = "no-verdict"
    /// It was sent back for the third time for the same line.
    case rewriteLimit = "rewrite-limit"
}

/// One of the dove's issues with a draft, with its score from 0 to 1.
public struct ApprovalIssue: Equatable, Sendable {
    public let name: String
    public let label: String
    public let score: Double
    /// The score is over the threshold.
    public let flagged: Bool

    public init(name: String, label: String, score: Double, flagged: Bool) {
        self.name = name
        self.label = label
        self.score = score
        self.flagged = flagged
    }
}

/// The line the post answers: who said it, when (in the owner's time zone, as the server wrote it), and how it
/// begins (up to 100 characters).
public struct ApprovalReplyTarget: Equatable, Sendable {
    public let speaker: String
    public let at: String
    public let text: String

    public init(speaker: String, at: String, text: String) {
        self.speaker = speaker
        self.at = at
        self.text = text
    }
}

public struct ApprovalTarget: Equatable, Sendable {
    /// `work/#dev`, or `work/@name` for a direct message.
    public let channel: String
    /// nil for a post to the channel itself.
    public let replyTo: ApprovalReplyTarget?
    /// nil when the value is not one this app knows.
    public let placement: ApprovalPlacement?

    public init(channel: String, replyTo: ApprovalReplyTarget?, placement: ApprovalPlacement?) {
        self.channel = channel
        self.replyTo = replyTo
        self.placement = placement
    }
}

/// How likely the dove found each place.
public struct ApprovalPlacementOdds: Equatable, Sendable {
    public let thread: Double
    public let channel: Double

    public init(thread: Double, channel: Double) {
        self.thread = thread
        self.channel = channel
    }
}

public struct ApprovalReason: Equatable, Sendable {
    /// nil when the value is not one this app knows.
    public let verdict: ApprovalVerdict?
    /// Empty when there was no verdict.
    public let issues: [ApprovalIssue]
    /// nil when there was no verdict, or the dove gave no odds.
    public let placementOdds: ApprovalPlacementOdds?

    public init(verdict: ApprovalVerdict?, issues: [ApprovalIssue], placementOdds: ApprovalPlacementOdds?) {
        self.verdict = verdict
        self.issues = issues
        self.placementOdds = placementOdds
    }
}

/// A draft for the same line that was sent back before, with the issues flagged then.
public struct ApprovalPastDraft: Equatable, Sendable {
    public let text: String
    public let issues: [ApprovalIssue]

    public init(text: String, issues: [ApprovalIssue]) {
        self.text = text
        self.issues = issues
    }
}

/// A Slack post waiting for the owner: approve, edit or reject. The approval binds the whole of it — the text, the
/// line it answers and where it goes (ADR 0002, ADR 0012).
public struct Approval: Equatable, Sendable {
    public let approvalId: String
    public let revision: Int
    /// Read once when it arrives; nil when the server's timestamp cannot be read.
    public let createdAt: Date?
    public let expiresAt: Date?
    public let target: ApprovalTarget
    /// natsumi's draft, whole.
    public let text: String
    /// The face on the post's icon (ADR 0026); nil when there is none or it is not one this app knows.
    public let expression: Expression?
    public let reason: ApprovalReason
    /// Oldest first.
    public let history: [ApprovalPastDraft]

    public init(
        approvalId: String, revision: Int, createdAt: Date?, expiresAt: Date?, target: ApprovalTarget, text: String,
        expression: Expression?, reason: ApprovalReason, history: [ApprovalPastDraft]
    ) {
        self.approvalId = approvalId
        self.revision = revision
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.target = target
        self.text = text
        self.expression = expression
        self.reason = reason
        self.history = history
    }
}

extension Approval: Decodable {
    private struct Wire: Decodable {
        struct Target: Decodable {
            let channel: String
            let replyTo: ReplyTo?
            let placement: String?
        }

        struct ReplyTo: Decodable {
            let speaker: String
            let at: String
            let text: String
        }

        struct Issue: Decodable {
            let name: String
            let label: String
            let score: Double
            let flagged: Bool?

            var issue: ApprovalIssue { ApprovalIssue(name: name, label: label, score: score, flagged: flagged ?? false) }
        }

        struct Reason: Decodable {
            struct Placement: Decodable { let probabilities: Odds? }
            struct Odds: Decodable {
                let thread: Double
                let channel: Double
            }

            let verdict: String?
            let issues: [Issue]?
            let placement: Placement?
        }

        struct Draft: Decodable {
            let text: String
            let issues: [Issue]?
        }

        let approvalId: String
        let revision: Int
        let kind: String
        let createdAt: String?
        let expiresAt: String?
        let target: Target
        let text: String
        let expression: String?
        let reason: Reason?
        let history: [Draft]?
    }

    public init(from decoder: Decoder) throws {
        let wire = try Wire(from: decoder)
        // Only Slack posts are drawn here; approvals of other kinds are for later screens.
        guard wire.kind == "slack-post" else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a slack-post"))
        }
        let odds = wire.reason?.placement?.probabilities
        self.init(
            approvalId: wire.approvalId, revision: wire.revision, createdAt: wire.createdAt.flatMap(parseTimestamp),
            expiresAt: wire.expiresAt.flatMap(parseTimestamp),
            target: ApprovalTarget(
                channel: wire.target.channel,
                replyTo: wire.target.replyTo.map { ApprovalReplyTarget(speaker: $0.speaker, at: $0.at, text: $0.text) },
                placement: wire.target.placement.flatMap(ApprovalPlacement.init(rawValue:))),
            text: wire.text, expression: wire.expression.flatMap(Expression.init(rawValue:)),
            reason: ApprovalReason(
                verdict: wire.reason?.verdict.flatMap(ApprovalVerdict.init(rawValue:)),
                issues: (wire.reason?.issues ?? []).map(\.issue),
                placementOdds: odds.map { ApprovalPlacementOdds(thread: $0.thread, channel: $0.channel) }),
            history: (wire.history ?? []).map { ApprovalPastDraft(text: $0.text, issues: ($0.issues ?? []).map(\.issue)) })
    }
}

/// How an approval was closed.
public enum ApprovalOutcome: String, Equatable, Sendable {
    case approved, edited, rejected, expired
}

/// What came of sending an approved or edited post.
public enum ApprovalDelivery: Equatable, Sendable {
    case sent
    /// `mechanical-check`, `slack-error` or `target-gone`; nil when the server did not say.
    case failed(reason: String?)
}

/// `approval.resolved`: an approval was closed, on this device or another.
public struct ApprovalResolution: Equatable, Sendable {
    public let approvalId: String
    public let revision: Int
    /// nil when the value is not one this app knows.
    public let outcome: ApprovalOutcome?
    /// nil when nothing was sent: rejected or expired.
    public let delivery: ApprovalDelivery?
    /// The text that was actually sent.
    public let sentText: String?

    public init(approvalId: String, revision: Int, outcome: ApprovalOutcome?, delivery: ApprovalDelivery?, sentText: String?) {
        self.approvalId = approvalId
        self.revision = revision
        self.outcome = outcome
        self.delivery = delivery
        self.sentText = sentText
    }
}

extension ApprovalResolution: Decodable {
    private enum CodingKeys: String, CodingKey { case approvalId, revision, state, delivery, reason, sentText }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let delivery: ApprovalDelivery? = switch try values.decodeIfPresent(String.self, forKey: .delivery) {
        case "sent": .sent
        case "failed": .failed(reason: try values.decodeIfPresent(String.self, forKey: .reason))
        default: nil
        }
        self.init(
            approvalId: try values.decode(String.self, forKey: .approvalId), revision: try values.decode(Int.self, forKey: .revision),
            outcome: try values.decodeIfPresent(String.self, forKey: .state).flatMap(ApprovalOutcome.init(rawValue:)),
            delivery: delivery, sentText: try values.decodeIfPresent(String.self, forKey: .sentText))
    }
}

/// What the owner chose. A new placement goes only with approving or editing.
public enum ApprovalDecision: Equatable, Sendable {
    case approve(placement: ApprovalPlacement?)
    case edit(text: String, placement: ApprovalPlacement?)
    case reject
}

/// Reads a list one element at a time, so that one the app cannot read does not take the rest with it.
struct Lossy<Element: Decodable>: Decodable {
    let elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else {
                _ = try? container.decode(Skipped.self)
            }
        }
        self.elements = elements
    }

    private struct Skipped: Decodable {}
}

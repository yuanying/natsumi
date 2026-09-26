import CryptoKit
import Foundation

/// Which APNs the server sends through: the development one for an app signed for development, the production one
/// for a distributed build (ADR 0029).
public enum PushEnvironment: String, Equatable, Sendable {
    case sandbox
    case production

    /// The APNs the app's signature is for, from the `aps-environment` of its embedded provisioning profile. A
    /// build from the App Store has no profile and uses production; so does a profile without the entitlement.
    public init(provisioningProfile: Data?) {
        // The profile is a signed plist; the plist itself is plain text inside it.
        let text = provisioningProfile.map { String(decoding: $0, as: UTF8.self) } ?? ""
        let pattern = /<key>aps-environment<\/key>\s*<string>(\w+)<\/string>/
        self = text.firstMatch(of: pattern)?.1 == "development" ? .sandbox : .production
    }
}

/// What `push.register` tells the server: where to send, and the key to seal the text to.
public struct PushRegistration: Equatable, Sendable {
    /// The device token in lowercase hex.
    public let token: String
    /// The public key, X9.63 uncompressed, in standard base64.
    public let publicKey: String
    public let environment: PushEnvironment

    public init(token: String, publicKey: String, environment: PushEnvironment) {
        self.token = token
        self.publicKey = publicKey
        self.environment = environment
    }

    public init(deviceToken: Data, publicKey: P256.KeyAgreement.PublicKey, environment: PushEnvironment) {
        self.init(
            token: deviceToken.map { String(format: "%02x", $0) }.joined(),
            publicKey: publicKey.x963Representation.base64EncodedString(), environment: environment)
    }
}

/// Which delivered notifications to take away, and what the badge should say.
public enum PushTidy: Equatable, Sendable {
    /// After a sync: what is still unread, unchecked or waiting for the owner stays, and nothing else.
    case synced(badge: Int, unreadReplyIds: Set<String>, unacknowledgedIds: Set<String>, pendingApprovalIds: Set<String> = [])
    /// After a silent push while away: what it says was read or checked goes.
    case background(BackgroundPush)
    /// After a silent push while away: the alert of the approval that closed goes.
    case approvalResolved(ApprovalResolvedPush)

    public var badge: Int {
        switch self {
        case .synced(let badge, _, _, _): badge
        case .background(let push): push.badge
        case .approvalResolved(let push): push.badge
        }
    }

    public func removes(_ alert: AlertPush) -> Bool {
        switch self {
        case .synced(_, let unread, let unacknowledged, _):
            switch alert.kind {
            case .reply: !unread.contains(alert.messageId)
            case .notice: !unacknowledged.contains(alert.messageId)
            }
        case .background(let push):
            switch alert.kind {
            case .reply: push.readThroughPosition.map { alert.position <= $0 } ?? false
            // Reading past a notice does not check it (ADR 0013).
            case .notice: alert.messageId == push.notificationId
            }
        case .approvalResolved:
            false
        }
    }

    public func removes(_ alert: ApprovalAlertPush) -> Bool {
        switch self {
        case .synced(_, _, _, let pending): !pending.contains(alert.approvalId)
        case .background: false
        case .approvalResolved(let push): alert.approvalId == push.approvalId
        }
    }

    /// Whether a delivered notification of either kind goes.
    public func removes(userInfo: [AnyHashable: Any]) -> Bool {
        if let alert = AlertPush(userInfo: userInfo) { return removes(alert) }
        if let alert = ApprovalAlertPush(userInfo: userInfo) { return removes(alert) }
        return false
    }

    /// What the conversation and the approvals say now. The badge counts what is unread, unchecked and waiting for
    /// the owner, as the server's does.
    static func synced(_ conversation: ConversationState, approvals: ApprovalBook) -> PushTidy {
        .synced(
            badge: conversation.unreadReplyCount + conversation.unacknowledgedNotificationIds.count + approvals.pending.count,
            unreadReplyIds: Set(conversation.unreadReplies.map(\.messageId)),
            unacknowledgedIds: Set(conversation.unacknowledgedNotificationIds),
            pendingApprovalIds: Set(approvals.pending.map(\.approvalId)))
    }
}

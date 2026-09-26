import Foundation

/// An approval that was closed while this device was watching, with what came of it.
public struct ClosedApproval: Equatable, Sendable {
    /// nil when it closed before this device had seen it.
    public let approval: Approval?
    public let resolution: ApprovalResolution

    public init(approval: Approval?, resolution: ApprovalResolution) {
        self.approval = approval
        self.resolution = resolution
    }
}

/// The owner's decision on its way to the server.
public struct SentDecision: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        /// Sent, or waiting for the sync to be sent.
        case sending
        /// The server took it and left the approval in this state; what came of sending follows in
        /// `approval.resolved`.
        case accepted(ApprovalOutcome?)
        /// The server refused it with this code; the owner may choose again.
        case failed(String)
    }

    public let requestId: String
    public let approvalId: String
    public let revision: Int
    public let decision: ApprovalDecision
    public var status: Status

    var command: ClientCommand { .approvalDecide(approvalId: approvalId, revision: revision, decision: decision) }
}

/// The Slack posts waiting for the owner, as the server says, and the owner's decisions not settled yet.
public struct ApprovalBook: Equatable, Sendable {
    /// Oldest first.
    public private(set) var pending: [Approval] = []
    /// Approvals closed since this device started watching, by ID.
    public private(set) var closed: [String: ClosedApproval] = [:]
    /// The owner's decision on each approval, by approval ID, until it is closed.
    public private(set) var decisions: [String: SentDecision] = [:]

    public init() {}

    /// A pending approval, or one that closed while this device was watching.
    public func approval(_ id: String) -> Approval? {
        pending.first { $0.approvalId == id } ?? closed[id]?.approval
    }

    /// Decisions to send (again) once synced: a decision is idempotent on the server, which answers one for a
    /// closed approval with the state it closed in.
    var unsent: [SentDecision] {
        pending.compactMap { decisions[$0.approvalId] }.filter { $0.status == .sending }
    }

    /// Records the owner's decision. Nothing is recorded — and so nothing sent — for an approval that is not pending,
    /// or while an earlier decision on it is on its way or was taken.
    mutating func decide(_ approvalId: String, _ decision: ApprovalDecision, requestId: String) -> SentDecision? {
        guard let approval = pending.first(where: { $0.approvalId == approvalId }) else { return nil }
        switch decisions[approvalId]?.status {
        case .sending, .accepted: return nil
        case .failed, nil: break
        }
        let sent = SentDecision(
            requestId: requestId, approvalId: approvalId, revision: approval.revision, decision: decision, status: .sending)
        decisions[approvalId] = sent
        return sent
    }

    mutating func apply(_ event: ServerEvent, requestId: String? = nil) {
        switch event {
        case .snapshot(let snapshot):
            pending = snapshot.pendingApprovals
            // A decision on an approval that closed meanwhile has nothing left to do.
            let ids = Set(pending.map(\.approvalId))
            decisions = decisions.filter { ids.contains($0.key) }
        case .approvalPending(let approval):
            if let index = pending.firstIndex(where: { $0.approvalId == approval.approvalId }) {
                guard approval.revision > pending[index].revision else { return }
                pending[index] = approval
                // A decision was for the revision the owner saw; a new one is to be looked at afresh.
                decisions[approval.approvalId] = nil
            } else {
                pending.append(approval)
            }
        case .approvalResolved(let resolution):
            let id = resolution.approvalId
            closed[id] = ClosedApproval(approval: approval(id), resolution: resolution)
            pending.removeAll { $0.approvalId == id }
            decisions[id] = nil
        case .accepted(let accepted):
            guard let id = decisionId(requestId) else { return }
            decisions[id]?.status = .accepted(accepted.approvalOutcome)
        case .rejected(let code), .unavailable(let code, _):
            guard let id = decisionId(requestId) else { return }
            // Sent before the sync: it goes again, under the same request ID, once synced.
            decisions[id]?.status = code == "sync-required" ? .sending : .failed(code)
        default:
            break
        }
    }

    private func decisionId(_ requestId: String?) -> String? {
        guard let requestId else { return nil }
        return decisions.first { $0.value.requestId == requestId }?.key
    }
}

import Foundation
@testable import NatsumiCore

/// Server envelopes as the server writes them, built from plain dictionaries so the tests exercise real decoding.
enum Fixture {
    static let epoch = "epoch-example"
    static let stream = "stream-example"

    static func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    static func envelope(
        _ type: String, seq: Int, epoch: String = epoch, stream: String = stream,
        requestId: String? = nil, payload: [String: Any] = [:]
    ) -> Data {
        var object: [String: Any] = ["v": 1, "epoch": epoch, "streamId": stream, "seq": seq, "type": type, "payload": payload]
        if let requestId { object["requestId"] = requestId }
        return json(object)
    }

    static func message(
        _ id: String, role: String = "natsumi", kind: String = "reply", text: String = "こんにちは",
        eventId: String? = nil, replyTo: String? = nil, expression: String? = nil
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "messageId": id, "role": role, "kind": kind, "text": text, "createdAt": "2026-01-01T00:00:00.000Z",
        ]
        if let eventId { payload["eventId"] = eventId }
        if let replyTo { payload["replyTo"] = replyTo }
        if let expression { payload["expression"] = expression }
        return payload
    }

    static func snapshot(
        seq: Int, stream: String = stream, requestId: String? = nil, deviceId: String = "device-example",
        messages: [[String: Any]] = [], pending: [[String: Any]] = [], expression: String = "neutral",
        readThrough: String? = nil, unreadReplyCount: Int = 0, unacknowledged: [String] = [],
        approvals: [[String: Any]]? = nil
    ) -> Data {
        var payload: [String: Any] = [
            "deviceId": deviceId, "messages": messages, "pendingEvents": pending, "avatar": ["expression": expression],
            "readThroughMessageId": readThrough.map { $0 as Any } ?? NSNull(), "unreadReplyCount": unreadReplyCount,
            "unacknowledgedNotificationIds": unacknowledged,
        ]
        if let approvals { payload["pendingApprovals"] = approvals }
        return envelope("session.snapshot", seq: seq, stream: stream, requestId: requestId, payload: payload)
    }

    /// An approval of a Slack post as the server writes it, with made-up values: a reply in a thread that the dove
    /// handed to the owner, with one issue over the threshold.
    static func approval(
        _ id: String, revision: Int = 1, text: String = "明日の 10 時で大丈夫です。", channel: String = "work/#dev",
        replyTo: [String: Any]? = ["speaker": "山田", "at": "2026-09-25 14:32:05", "text": "明日の打ち合わせ、何時がいいですか？"],
        placement: String = "thread", verdict: String = "owner", expression: String? = "happy",
        issues: [[String: Any]] = [
            ["name": "promise", "label": "本人に代わる約束・期限", "score": 0.82, "flagged": true],
            ["name": "missing-context", "label": "スレッドに無い情報", "score": 0.12],
        ],
        probabilities: [String: Double]? = ["thread": 0.7, "channel": 0.3], history: [[String: Any]] = []
    ) -> [String: Any] {
        var target: [String: Any] = ["channel": channel, "placement": placement]
        if let replyTo { target["replyTo"] = replyTo }
        var reason: [String: Any] = ["verdict": verdict, "issues": issues]
        if let probabilities { reason["placement"] = ["probabilities": probabilities] }
        var approval: [String: Any] = [
            "approvalId": id, "revision": revision, "kind": "slack-post", "createdAt": "2026-09-22T05:30:00.000Z",
            "expiresAt": "2026-09-29T05:30:00.000Z", "target": target, "text": text, "reason": reason, "history": history,
        ]
        if let expression { approval["expression"] = expression }
        return approval
    }

    static func approvalPending(_ approval: [String: Any], seq: Int) -> Data {
        envelope("approval.pending", seq: seq, payload: approval)
    }

    static func approvalResolved(
        _ id: String, seq: Int, state: String = "approved", delivery: String? = "sent", reason: String? = nil,
        sentText: String? = "明日の 10 時で大丈夫です。"
    ) -> Data {
        var payload: [String: Any] = ["approvalId": id, "revision": 1, "state": state, "resolvedAt": "2026-09-22T05:40:00.000Z"]
        if let delivery { payload["delivery"] = delivery }
        if let reason { payload["reason"] = reason }
        if let sentText { payload["sentText"] = sentText }
        return envelope("approval.resolved", seq: seq, payload: payload)
    }

    /// The line of thinking: an event of the moment, which carries the number the stream is already at (ADR 0017).
    static func thinking(_ line: String, seq: Int, stream: String = stream, epoch: String = epoch) -> Data {
        envelope("conversation.thinking", seq: seq, epoch: epoch, stream: stream, payload: ["line": line])
    }

    static func decoded(_ data: Data) -> ServerEnvelope {
        try! ServerEnvelope.decode(data)
    }

    /// The JSON object a client envelope encodes to.
    static func object(_ envelope: ClientEnvelope) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: envelope.encoded()) as! [String: Any]
    }
}

/// A secret store that keeps everything in memory and remembers what was written.
final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private(set) var items: [String: Data] = [:]

    func read(account: String) throws -> Data? { items[account] }
    func write(_ data: Data, account: String) throws { items[account] = data }
    func delete(account: String) throws { items[account] = nil }
}

extension MessageTime {
    /// 2026-09-22 15:00 in Tokyo: a fixed now, so the history's times do not depend on when the tests run.
    static let example: MessageTime = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return MessageTime(now: parseTimestamp("2026-09-22T06:00:00Z")!, calendar: calendar)
    }()
}

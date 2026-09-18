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
        eventId: String? = nil, replyTo: String? = nil
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "messageId": id, "role": role, "kind": kind, "text": text, "createdAt": "2026-01-01T00:00:00.000Z",
        ]
        if let eventId { payload["eventId"] = eventId }
        if let replyTo { payload["replyTo"] = replyTo }
        return payload
    }

    static func snapshot(
        seq: Int, stream: String = stream, requestId: String? = nil, deviceId: String = "device-example",
        messages: [[String: Any]] = [], pending: [[String: Any]] = [], expression: String = "neutral",
        readThrough: String? = nil, unreadReplyCount: Int = 0, unacknowledged: [String] = []
    ) -> Data {
        envelope("session.snapshot", seq: seq, stream: stream, requestId: requestId, payload: [
            "deviceId": deviceId, "messages": messages, "pendingEvents": pending, "avatar": ["expression": expression],
            "readThroughMessageId": readThrough.map { $0 as Any } ?? NSNull(), "unreadReplyCount": unreadReplyCount,
            "unacknowledgedNotificationIds": unacknowledged,
        ])
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

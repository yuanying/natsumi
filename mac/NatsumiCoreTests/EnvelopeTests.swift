import Foundation
import Testing
@testable import NatsumiCore

@Suite("サーバーの envelope を読む")
struct ServerEnvelopeTests {
    @Test("返事の conversation.message を、stream の位置と一緒に読む")
    func reply() throws {
        let envelope = try ServerEnvelope.decode(Data(#"""
        {"v":1,"epoch":"epoch-example","streamId":"stream-example","seq":42,"type":"conversation.message","payload":{"messageId":"message-example","role":"natsumi","kind":"reply","text":"こんにちは","replyTo":"event-example","createdAt":"2026-01-01T00:00:00.000Z"}}
        """#.utf8))
        #expect(envelope.position == StreamPosition(epoch: "epoch-example", streamId: "stream-example", seq: 42))
        #expect(envelope.requestId == nil)
        #expect(envelope.event == .message(ShownMessage(
            messageId: "message-example", role: .natsumi, kind: .reply, text: "こんにちは",
            createdAt: "2026-01-01T00:00:00.000Z", replyTo: "event-example")))
    }

    @Test("本人のメッセージはイベントの ID を、知らせは関係するイベントを持つ")
    func ownerMessageAndNotice() {
        let owner = Fixture.decoded(Fixture.envelope("conversation.message", seq: 1,
            payload: Fixture.message("m1", role: "owner", kind: "message", text: "架空のメッセージ", eventId: "e1")))
        #expect(owner.event == .message(ShownMessage(
            messageId: "m1", role: .owner, kind: .message, text: "架空のメッセージ", createdAt: "2026-01-01T00:00:00.000Z", eventId: "e1")))

        var notice = Fixture.message("m2", kind: "notice", text: "お知らせ")
        notice["about"] = ["e1"]
        let decoded = Fixture.decoded(Fixture.envelope("conversation.message", seq: 2, payload: notice))
        #expect(decoded.event == .message(ShownMessage(
            messageId: "m2", role: .natsumi, kind: .notice, text: "お知らせ", createdAt: "2026-01-01T00:00:00.000Z", about: ["e1"])))
    }

    @Test("session.snapshot は端末 ID・履歴・処理待ち・表情を持つ")
    func snapshot() {
        let envelope = Fixture.decoded(Fixture.snapshot(
            seq: 7, requestId: "request-sync", deviceId: "device-1",
            messages: [Fixture.message("m1", role: "owner", kind: "message", text: "やあ", eventId: "e1")],
            pending: [["eventId": "e1", "messageId": "m1", "state": "processing"]], expression: "thinking"))
        #expect(envelope.requestId == "request-sync")
        #expect(envelope.event == .snapshot(Snapshot(
            deviceId: "device-1",
            messages: [ShownMessage(messageId: "m1", role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: "e1")],
            pendingEvents: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)],
            expression: .thinking)))
    }

    @Test("session.snapshot は既読のカーソル・未読の返事の数・未確認の知らせを持つ")
    func snapshotReadState() {
        let envelope = Fixture.decoded(Fixture.snapshot(
            seq: 7, deviceId: "device-1", readThrough: "m1", unreadReplyCount: 3, unacknowledged: ["n1", "n2"]))
        guard case .snapshot(let snapshot) = envelope.event else {
            Issue.record("snapshot として読めなかった")
            return
        }
        #expect(snapshot.readState == ReadState(readThroughMessageId: "m1", unreadReplyCount: 3, unacknowledgedNotificationIds: ["n1", "n2"]))

        let empty = Fixture.decoded(Fixture.snapshot(seq: 8))
        guard case .snapshot(let first) = empty.event else {
            Issue.record("snapshot として読めなかった")
            return
        }
        #expect(first.readState == ReadState(readThroughMessageId: nil, unreadReplyCount: 0, unacknowledgedNotificationIds: []))
    }

    @Test("conversation.read と notification.acked のイベントを読む")
    func readEvents() {
        let read = Fixture.decoded(Fixture.envelope("conversation.read", seq: 3,
            payload: ["readThroughMessageId": "m4", "unreadReplyCount": 1]))
        #expect(read.event == .readMoved(readThroughMessageId: "m4", unreadReplyCount: 1))
        let acked = Fixture.decoded(Fixture.envelope("notification.acked", seq: 4,
            payload: ["notificationId": "n1", "acknowledgedAt": "2026-01-01T00:00:00.000Z"]))
        #expect(acked.event == .notificationAcked(notificationId: "n1"))
    }

    @Test("確認への command.accepted は、今のカーソルと件数、または確認した知らせを持つ")
    func acceptedReadAndAck() {
        let read = Fixture.decoded(Fixture.envelope("command.accepted", seq: 5, requestId: "r1",
            payload: ["readThroughMessageId": "m4", "unreadReplyCount": 2]))
        #expect(read.event == .accepted(CommandAccepted(readThroughMessageId: "m4", unreadReplyCount: 2)))
        let ack = Fixture.decoded(Fixture.envelope("command.accepted", seq: 6, requestId: "r2",
            payload: ["notificationId": "n1", "acknowledgedAt": "2026-01-01T00:00:00.000Z"]))
        #expect(ack.event == .accepted(CommandAccepted(notificationId: "n1")))
    }

    @Test("8 つの表情をすべて読める")
    func expressions() {
        for expression in Expression.allCases {
            let envelope = Fixture.decoded(Fixture.envelope("avatar.expression", seq: 1, payload: ["expression": expression.rawValue]))
            #expect(envelope.event == .expression(expression))
        }
        #expect(Expression.allCases.map(\.rawValue) == ["neutral", "happy", "laughing", "surprised", "thinking", "worried", "sad", "sleepy"])
    }

    @Test("イベントの完了は状態と、失敗の理由を持つ")
    func completion() {
        let failed = Fixture.decoded(Fixture.envelope("conversation.event.completed", seq: 3,
            payload: ["eventId": "e1", "messageId": "m1", "status": "failed", "reason": "timeout"]))
        #expect(failed.event == .eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .failed, reason: "timeout")))
        let noReply = Fixture.decoded(Fixture.envelope("conversation.event.completed", seq: 4,
            payload: ["eventId": "e2", "messageId": "m2", "status": "no-reply"]))
        #expect(noReply.event == .eventCompleted(EventCompletion(eventId: "e2", messageId: "m2", status: .noReply, reason: nil)))
    }

    @Test("command.accepted は送信の受付と、再送の同期の完了を区別できる")
    func accepted() {
        let send = Fixture.decoded(Fixture.envelope("command.accepted", seq: 5, requestId: "r1",
            payload: ["messageId": "m1", "eventId": "e1", "state": "queued"]))
        #expect(send.event == .accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .queued)))
        let resume = Fixture.decoded(Fixture.envelope("command.accepted", seq: 6, requestId: "r2",
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(resume.event == .accepted(CommandAccepted(deviceId: "device-1", mode: "resume")))
    }

    @Test("拒否とサービス停止はエラーコードだけを持つ")
    func rejections() {
        let rejected = Fixture.decoded(Fixture.envelope("command.rejected", seq: 1, requestId: "r1", payload: ["code": "request-conflict"]))
        #expect(rejected.event == .rejected(code: "request-conflict"))
        let unavailable = Fixture.decoded(Fixture.envelope("service.unavailable", seq: 2, requestId: "r2",
            payload: ["code": "pi-unavailable", "deviceId": "device-1"]))
        #expect(unavailable.event == .unavailable(code: "pi-unavailable", deviceId: "device-1"))
    }

    @Test("未知の type は、位置だけを持つイベントなしの envelope になる")
    func unknownType() {
        let envelope = Fixture.decoded(Fixture.envelope("notification.batch", seq: 9, payload: ["anything": true]))
        #expect(envelope.event == nil)
        #expect(envelope.position.seq == 9)
    }

    @Test("未知の表情や、欠けた payload の既知の type も無視する")
    func unknownValues() {
        #expect(Fixture.decoded(Fixture.envelope("avatar.expression", seq: 1, payload: ["expression": "angry"])).event == nil)
        #expect(Fixture.decoded(Fixture.envelope("conversation.message", seq: 2, payload: ["text": "id がない"])).event == nil)
    }

    @Test("v が 1 でなければ読まない")
    func unsupportedVersion() {
        let data = Fixture.json(["v": 2, "epoch": "e", "streamId": "s", "seq": 1, "type": "avatar.expression", "payload": [:]])
        #expect(throws: EnvelopeError.unsupportedVersion) { try ServerEnvelope.decode(data) }
    }

    @Test("JSON のオブジェクトでない、または位置が欠けたものは読まない")
    func malformed() {
        #expect(throws: EnvelopeError.malformed) { try ServerEnvelope.decode(Data("not json".utf8)) }
        #expect(throws: EnvelopeError.malformed) { try ServerEnvelope.decode(Data("[1]".utf8)) }
        #expect(throws: EnvelopeError.malformed) {
            try ServerEnvelope.decode(Fixture.json(["v": 1, "type": "avatar.expression", "payload": [:]]))
        }
    }
}

@Suite("クライアントの command を書く")
struct ClientEnvelopeTests {
    @Test("初回の session.sync は deviceId を省き、resume に null を入れる")
    func firstSync() {
        let object = Fixture.object(ClientEnvelope(requestId: "r1", deviceId: nil, command: .sessionSync(resume: nil)))
        #expect(object["v"] as? Int == 1)
        #expect(object["type"] as? String == "session.sync")
        #expect(object["requestId"] as? String == "r1")
        #expect(object.keys.contains("deviceId") == false)
        let payload = object["payload"] as? [String: Any]
        #expect(payload?.keys.contains("resume") == true)
        #expect(payload?["resume"] is NSNull)
    }

    @Test("再接続の session.sync は、前回の位置と保存した端末 ID を送る")
    func resumeSync() {
        let position = StreamPosition(epoch: "e1", streamId: "s1", seq: 12)
        let object = Fixture.object(ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .sessionSync(resume: position)))
        #expect(object["deviceId"] as? String == "device-1")
        let resume = (object["payload"] as? [String: Any])?["resume"] as? [String: Any]
        #expect(resume?["epoch"] as? String == "e1")
        #expect(resume?["streamId"] as? String == "s1")
        #expect(resume?["seq"] as? Int == 12)
    }

    @Test("conversation.send は本文を payload の text に入れる")
    func send() {
        let object = Fixture.object(ClientEnvelope(requestId: "r3", deviceId: "device-1", command: .conversationSend(text: "架空のメッセージ")))
        #expect(object["type"] as? String == "conversation.send")
        #expect((object["payload"] as? [String: Any])?["text"] as? String == "架空のメッセージ")
    }

    @Test("conversation.read は throughMessageId を、notification.ack は notificationId を payload に入れる")
    func readAndAck() {
        let read = Fixture.object(ClientEnvelope(requestId: "r4", deviceId: "device-1", command: .conversationRead(throughMessageId: "m4")))
        #expect(read["v"] as? Int == 1)
        #expect(read["requestId"] as? String == "r4")
        #expect(read["deviceId"] as? String == "device-1")
        #expect(read["type"] as? String == "conversation.read")
        #expect(read["payload"] as? [String: String] == ["throughMessageId": "m4"])

        let ack = Fixture.object(ClientEnvelope(requestId: "r5", deviceId: "device-1", command: .notificationAck(notificationId: "n1")))
        #expect(ack["type"] as? String == "notification.ack")
        #expect(ack["requestId"] as? String == "r5")
        #expect(ack["payload"] as? [String: String] == ["notificationId": "n1"])
    }
}

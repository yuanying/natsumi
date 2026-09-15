import Foundation
import Testing
@testable import NatsumiCore

@Suite("stream の連続性で、適用・無視・再同期を決める")
struct StreamTrackerTests {
    private func expression(seq: Int, stream: String = Fixture.stream, epoch: String = Fixture.epoch) -> ServerEnvelope {
        Fixture.decoded(Fixture.envelope("avatar.expression", seq: seq, epoch: epoch, stream: stream, payload: ["expression": "happy"]))
    }

    @Test("snapshot はどの位置からでも受け入れ、その seq を基準にする")
    func snapshotIsTheBarrier() {
        var tracker = StreamTracker()
        #expect(tracker.accept(Fixture.decoded(Fixture.snapshot(seq: 5))) == .apply)
        #expect(tracker.position == StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 5))
        #expect(tracker.accept(expression(seq: 6)) == .apply)
        #expect(tracker.position?.seq == 6)
    }

    @Test("同じ stream で seq が 1 つ進んだイベントを適用する")
    func contiguous() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        #expect(tracker.accept(expression(seq: 4)) == .apply)
        #expect(tracker.accept(expression(seq: 5)) == .apply)
        #expect(tracker.position?.seq == 5)
    }

    @Test("すでに受け取った seq は無視し、位置を戻さない")
    func duplicate() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        #expect(tracker.accept(expression(seq: 3)) == .ignore)
        #expect(tracker.accept(expression(seq: 2)) == .ignore)
        #expect(tracker.position?.seq == 3)
    }

    @Test("seq が欠けたら再同期を求め、位置は最後に適用したところに残す")
    func gap() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        #expect(tracker.accept(expression(seq: 5)) == .resync)
        #expect(tracker.position?.seq == 3)
    }

    @Test("epoch や stream が変わった会話のイベントは、再同期を求める")
    func otherStream() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        #expect(tracker.accept(expression(seq: 4, stream: "stream-other")) == .resync)
        #expect(tracker.accept(expression(seq: 4, epoch: "epoch-other")) == .resync)
        #expect(tracker.position?.seq == 3)
    }

    @Test("未知の type のイベントは適用しないが、seq は進める")
    func unknownTypeConsumesSeq() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        #expect(tracker.accept(Fixture.decoded(Fixture.envelope("notification.batch", seq: 4))) == .ignore)
        #expect(tracker.position?.seq == 4)
        #expect(tracker.accept(expression(seq: 5)) == .apply)
    }

    @Test("同期の前の一時的な stream の応答は適用するが、位置にしない")
    func answersBeforeSync() {
        var tracker = StreamTracker()
        let rejected = Fixture.decoded(Fixture.envelope("command.rejected", seq: 1, stream: "stream-local", requestId: "r1", payload: ["code": "sync-required"]))
        #expect(tracker.accept(rejected) == .apply)
        #expect(tracker.position == nil)
    }

    @Test("位置がないうちに届いた会話のイベントは、再同期を求める")
    func eventsBeforeSnapshot() {
        var tracker = StreamTracker()
        #expect(tracker.accept(expression(seq: 1)) == .resync)
    }

    @Test("同期の応答の service.unavailable は、端末の stream の位置になる")
    func unavailableBindsTheStream() {
        var tracker = StreamTracker()
        let unavailable = Fixture.decoded(Fixture.envelope("service.unavailable", seq: 1, requestId: "r1",
            payload: ["code": "pi-unavailable", "deviceId": "device-1"]))
        #expect(tracker.accept(unavailable) == .apply)
        #expect(tracker.position?.seq == 1)
        #expect(tracker.accept(expression(seq: 2)) == .apply)
    }

    @Test("位置を忘れると、次は snapshot を待つ")
    func reset() {
        var tracker = StreamTracker(position: StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 3))
        tracker.reset()
        #expect(tracker.position == nil)
    }
}

import Foundation
import Testing
@testable import NatsumiCore

@Suite("承認待ちの出し入れと、approval.decide を 1 回だけ送る")
struct ApprovalFlowTests {
    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    /// A machine synced with the server, with these approvals pending.
    private func synced(_ approvals: [[String: Any]] = [Fixture.approval("a1")]) -> SessionMachine {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1", approvals: approvals))
        return m
    }

    private func sent(_ effects: [SessionEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }
    }

    @Test("snapshot の承認待ちを持ち、approval.pending で足し、approval.resolved で閉じる")
    func pendingThenResolved() {
        var m = synced()
        #expect(m.approvals.pending.map(\.approvalId) == ["a1"])

        _ = m.received(Fixture.approvalPending(Fixture.approval("a2"), seq: 2))
        #expect(m.approvals.pending.map(\.approvalId) == ["a1", "a2"])
        // The same one again (a replay) is not added twice.
        _ = m.received(Fixture.approvalPending(Fixture.approval("a2"), seq: 3))
        #expect(m.approvals.pending.map(\.approvalId) == ["a1", "a2"])

        _ = m.received(Fixture.approvalResolved("a1", seq: 4))
        #expect(m.approvals.pending.map(\.approvalId) == ["a2"])
        #expect(m.approvals.closed["a1"]?.resolution.outcome == .approved)
        #expect(m.approvals.closed["a1"]?.approval?.text == "明日の 10 時で大丈夫です。")
        #expect(m.approvals.approval("a1")?.approvalId == "a1")
    }

    @Test("新しい revision の approval.pending は、前のものを置き換える")
    func newerRevision() {
        var m = synced()
        _ = m.received(Fixture.approvalPending(Fixture.approval("a1", revision: 2, text: "書き直した下書き"), seq: 2))
        #expect(m.approvals.pending.map(\.revision) == [2])
        #expect(m.approvals.pending.first?.text == "書き直した下書き")
    }

    @Test("snapshot は承認待ちを置き換える")
    func snapshotReplaces() {
        var m = synced([Fixture.approval("a1"), Fixture.approval("a2")])
        _ = m.stop()
        _ = m.start()
        let sync = sent(m.connected())[0]
        _ = m.received(Fixture.snapshot(seq: 1, stream: "stream-2", requestId: sync.requestId, deviceId: "device-1",
            approvals: [Fixture.approval("a2")]))
        #expect(m.approvals.pending.map(\.approvalId) == ["a2"])
    }

    @Test("決定は、承認待ちの revision で approval.decide にして送る")
    func decide() {
        var m = synced()
        let effects = m.decideApproval("a1", .approve(placement: nil))
        #expect(sent(effects) == [ClientEnvelope(
            requestId: "r2", deviceId: "device-1", command: .approvalDecide(approvalId: "a1", revision: 1, decision: .approve(placement: nil)))])
        #expect(m.approvals.decisions["a1"]?.status == .sending)
    }

    @Test("二重に押しても、1 回だけ送る")
    func onlyOnce() {
        var m = synced()
        _ = m.decideApproval("a1", .approve(placement: nil))
        #expect(m.decideApproval("a1", .reject).isEmpty)
        #expect(m.decideApproval("a1", .approve(placement: nil)).isEmpty)
        _ = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: "r2",
            payload: ["approvalId": "a1", "revision": 1, "state": "approved"]))
        #expect(m.approvals.decisions["a1"]?.status == .accepted(.approved))
        #expect(m.decideApproval("a1", .reject).isEmpty)
    }

    @Test("承認待ちに無いものは送らない")
    func unknownApproval() {
        var m = synced()
        #expect(m.decideApproval("a9", .reject).isEmpty)
        _ = m.received(Fixture.approvalResolved("a1", seq: 2, state: "expired", delivery: nil, sentText: nil))
        #expect(m.decideApproval("a1", .reject).isEmpty)
    }

    @Test("stale-revision と invalid-request で断られたら、もう一度選べる")
    func rejected() {
        var m = synced()
        _ = m.decideApproval("a1", .approve(placement: nil))
        _ = m.received(Fixture.envelope("command.rejected", seq: 2, requestId: "r2", payload: ["code": "stale-revision"]))
        #expect(m.approvals.decisions["a1"]?.status == .failed("stale-revision"))
        #expect(sent(m.decideApproval("a1", .reject)).map(\.requestId) == ["r3"])
        _ = m.received(Fixture.envelope("command.rejected", seq: 3, requestId: "r3", payload: ["code": "invalid-request"]))
        #expect(m.approvals.decisions["a1"]?.status == .failed("invalid-request"))
    }

    @Test("新しい revision が届いたら、断られた決定は消える")
    func newerRevisionClearsFailure() {
        var m = synced()
        _ = m.decideApproval("a1", .approve(placement: nil))
        _ = m.received(Fixture.envelope("command.rejected", seq: 2, requestId: "r2", payload: ["code": "stale-revision"]))
        _ = m.received(Fixture.approvalPending(Fixture.approval("a1", revision: 2), seq: 3))
        #expect(m.approvals.decisions["a1"] == nil)
    }

    @Test("同期の前に選んだものと、sync-required で断られたものは、同期してから同じ requestId で送る")
    func beforeSync() {
        var m = synced()
        _ = m.stop()
        #expect(sent(m.decideApproval("a1", .reject)).isEmpty)
        #expect(m.approvals.decisions["a1"]?.status == .sending)
        _ = m.start()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(sent(effects).map(\.command) == [.approvalDecide(approvalId: "a1", revision: 1, decision: .reject)])
        #expect(sent(effects).map(\.requestId) == ["r2"])

        _ = m.received(Fixture.envelope("command.rejected", seq: 3, requestId: "r2", payload: ["code": "sync-required"]))
        #expect(m.approvals.decisions["a1"]?.status == .sending)
    }

    @Test("送れないまま閉じた承認の決定は、同期しても送らない")
    func closedWhileAway() {
        var m = synced()
        _ = m.stop()
        _ = m.decideApproval("a1", .reject)
        _ = m.start()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.snapshot(seq: 1, stream: "stream-2", requestId: sync.requestId, deviceId: "device-1", approvals: []))
        #expect(sent(effects).isEmpty)
        #expect(m.approvals.decisions["a1"] == nil)
    }

    @Test("送った結果の approval.resolved が届いたら、決定の送り中は終わる")
    func resolvedEndsSending() {
        var m = synced()
        _ = m.decideApproval("a1", .edit(text: "10 時でお願いします。", placement: nil))
        _ = m.received(Fixture.approvalResolved("a1", seq: 2, state: "edited", sentText: "10 時でお願いします。"))
        #expect(m.approvals.decisions["a1"] == nil)
        #expect(m.approvals.closed["a1"]?.resolution == ApprovalResolution(
            approvalId: "a1", revision: 1, outcome: .edited, delivery: .sent, sentText: "10 時でお願いします。"))
    }
}

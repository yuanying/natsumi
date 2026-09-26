import CryptoKit
import Foundation
import Testing
@testable import NatsumiCore

/// Seals the plaintext the way the server does (client-contract「e の暗号」), with `aad` as the additional data.
private func seal(_ plaintext: String, aad: String, to device: P256.KeyAgreement.PublicKey) throws -> SealedPushText {
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let epk = ephemeral.publicKey.x963Representation
    let secret = try ephemeral.sharedSecretFromKeyAgreement(with: device)
    let key = secret.hkdfDerivedSymmetricKey(
        using: SHA256.self, salt: epk + device.x963Representation, sharedInfo: Data("natsumi-push-v1".utf8),
        outputByteCount: 32)
    let box = try AES.GCM.seal(Data(plaintext.utf8), using: key, authenticating: Data(aad.utf8))
    return SealedPushText(epk: epk, nonce: Data(box.nonce), ct: box.ciphertext + box.tag)
}

private func eObject(_ sealed: SealedPushText) -> [String: Any] {
    ["v": 1, "epk": sealed.epk.base64EncodedString(), "nonce": sealed.nonce.base64EncodedString(),
     "ct": sealed.ct.base64EncodedString()]
}

@Suite("承認待ちの通知")
struct ApprovalPushTests {
    @Test("kind: approval の alert は、平文の approvalId と暗号文の e を持つ。会話の alert としては読まない")
    func alert() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "なつみ", "body": "承認待ちがあります"], "mutable-content": 1, "badge": 1],
            "kind": "approval", "approvalId": "a1", "e": ["v": 1, "epk": "AQ==", "nonce": "Ag==", "ct": "Aw=="],
        ]
        #expect(ApprovalAlertPush(userInfo: userInfo) == ApprovalAlertPush(
            approvalId: "a1", sealed: SealedPushText(epk: Data([1]), nonce: Data([2]), ct: Data([3]))))
        #expect(AlertPush(userInfo: userInfo) == nil)
        #expect(ApprovalAlertPush(userInfo: ["kind": "reply", "messageId": "m1", "position": 1]) == nil)
        #expect(ApprovalAlertPush(userInfo: ["kind": "approval"]) == nil)
    }

    @Test("approvalId を AAD にして、下書きの先頭とチャンネルを開く")
    func open() throws {
        let device = P256.KeyAgreement.PrivateKey()
        let sealed = try seal(#"{"text":"明日の 10 時で大丈夫です。","channel":"work/#dev"}"#, aad: "a1", to: device.publicKey)
        let alert = try #require(ApprovalAlertPush(userInfo: ["kind": "approval", "approvalId": "a1", "e": eObject(sealed)]))
        let text = try PushCrypto.openApproval(#require(alert.sealed), approvalId: alert.approvalId, with: device)
        #expect(text == ApprovalPushText(text: "明日の 10 時で大丈夫です。", channel: "work/#dev"))
        // Another ID as the additional data does not open it.
        #expect(throws: (any Error).self) { try PushCrypto.openApproval(sealed, approvalId: "a2", with: device) }
    }

    @Test("kind: approval-resolved の background は、approvalId とバッジを持つ")
    func resolved() {
        #expect(ApprovalResolvedPush(userInfo: ["aps": ["content-available": 1], "kind": "approval-resolved", "approvalId": "a1", "badge": 0])
            == ApprovalResolvedPush(approvalId: "a1", badge: 0))
        #expect(ApprovalResolvedPush(userInfo: ["kind": "read", "badge": 0]) == nil)
        #expect(BackgroundPush(userInfo: ["kind": "approval-resolved", "approvalId": "a1", "badge": 0]) == nil)
    }

    @Test("閉じた承認の通知は消し、会話の通知には触らない")
    func tidy() {
        let a1 = ApprovalAlertPush(approvalId: "a1", sealed: nil)
        let a2 = ApprovalAlertPush(approvalId: "a2", sealed: nil)
        let reply = AlertPush(messageId: "m1", kind: .reply, position: 1, sealed: nil)

        let resolved = PushTidy.approvalResolved(ApprovalResolvedPush(approvalId: "a1", badge: 3))
        #expect(resolved.badge == 3)
        #expect(resolved.removes(a1))
        #expect(!resolved.removes(a2))
        #expect(!resolved.removes(reply))

        let synced = PushTidy.synced(badge: 1, unreadReplyIds: ["m1"], unacknowledgedIds: [], pendingApprovalIds: ["a2"])
        #expect(synced.removes(a1))
        #expect(!synced.removes(a2))
        #expect(!synced.removes(reply))

        let read = PushTidy.background(BackgroundPush(badge: 0, readThroughPosition: 5, notificationId: nil))
        #expect(!read.removes(a1))
    }
}

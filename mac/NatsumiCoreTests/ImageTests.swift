import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("会話の画像（読み取り・取得・手元の保管・大きさ）")
struct ImageTests {
    private func decoded(_ data: Data) -> ServerEvent? {
        Fixture.decoded(data).event
    }

    // MARK: - Reading the contract

    @Test("返事の images を並んだ順に読む。width と height があれば大きさも読む")
    func readsTheImagesOfAReply() {
        let payload = Fixture.message("m1", images: [
            Fixture.image("image-a", width: 896, height: 1152), Fixture.image("image-b"),
        ])
        guard case .message(let message) = decoded(Fixture.envelope("conversation.message", seq: 1, payload: payload))
        else { Issue.record("not a message"); return }
        #expect(message.text == "猫を描いてみました。")
        #expect(message.images == [
            ShownImage(imageId: "image-a", mimeType: "image/png", bytes: 946_870, width: 896, height: 1152),
            ShownImage(imageId: "image-b", mimeType: "image/png", bytes: 946_870),
        ])
        #expect(message.images[0].aspectRatio == CGFloat(896) / 1152)
        #expect(message.images[1].aspectRatio == nil)
    }

    @Test("images の欄が無い行は、今までどおり画像の無い行として読む")
    func aLineWithoutImages() {
        guard case .message(let message) = decoded(Fixture.envelope("conversation.message", seq: 1, payload: Fixture.message("m1")))
        else { Issue.record("not a message"); return }
        #expect(message.images.isEmpty)
    }

    @Test("snapshot の messages の images も読む")
    func readsTheImagesInASnapshot() {
        let data = Fixture.snapshot(seq: 1, messages: [
            Fixture.message("m1", role: "owner", kind: "message", text: "猫を描いて", eventId: "e1"),
            Fixture.message("m2", images: [Fixture.image("image-a", width: 10, height: 20)]),
        ])
        guard case .snapshot(let snapshot) = decoded(data) else { Issue.record("not a snapshot"); return }
        #expect(snapshot.messages.map(\.images.count) == [0, 1])
        #expect(snapshot.messages[1].images[0].width == 10)
    }

    @Test("片方しか無い大きさ・正でない大きさは、大きさが無いものとして読む。読めない要素は飛ばし、残りと本文は残す")
    func toleratesOddEntries() {
        let payload = Fixture.message("m1", images: [
            Fixture.image("image-a", width: 896),
            Fixture.image("image-b", width: 0, height: 10),
            ["imageId": "image-c"],
            Fixture.image("image-d", width: 3, height: 4),
        ])
        guard case .message(let message) = decoded(Fixture.envelope("conversation.message", seq: 1, payload: payload))
        else { Issue.record("not a message"); return }
        #expect(message.images.map(\.imageId) == ["image-a", "image-b", "image-d"])
        #expect(message.images[0].width == nil && message.images[0].height == nil)
        #expect(message.images[1].width == nil && message.images[1].height == nil)
        #expect(message.images[2].aspectRatio == 0.75)
    }

    @Test("承認待ちの images を読む。無ければ空")
    func readsTheImagesOfAnApproval() {
        let with = Fixture.approvalPending(Fixture.approval("a1", images: [Fixture.image("image-a"), Fixture.image("image-b")]), seq: 1)
        guard case .approvalPending(let approval) = decoded(with) else { Issue.record("not an approval"); return }
        #expect(approval.images.map(\.imageId) == ["image-a", "image-b"])
        guard case .approvalPending(let plain) = decoded(Fixture.approvalPending(Fixture.approval("a2"), seq: 2))
        else { Issue.record("not an approval"); return }
        #expect(plain.images.isEmpty)
    }

    // MARK: - Fetching

    @Test("取得は GET /v1/images/<imageId> に Bearer を付ける")
    func buildsTheRequest() throws {
        let server = try ServerAddress("https://natsumi.example.net")
        let request = try #require(ImageAPI.request(server: server, token: "token-example", imageId: "image-a1"))
        #expect(request.url?.absoluteString == "https://natsumi.example.net/v1/images/image-a1")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-example")
    }

    @Test("英数字と - でない ID は道に入れない")
    func refusesIdsOutsideTheContract() throws {
        let server = try ServerAddress("https://natsumi.example.net")
        #expect(ImageAPI.request(server: server, token: "t", imageId: "../auth/logout") == nil)
        #expect(ImageAPI.request(server: server, token: "t", imageId: "") == nil)
        #expect(ImageAPI.request(server: server, token: "t", imageId: "a b") == nil)
    }

    @Test("200 の画像は読んで縮めたものを持つ。404 と画像でない本文は無いもの、それ以外は取れなかったもの")
    func readsTheAnswer() throws {
        let fetched = ImageAPI.fetch(status: 200, body: Fixture.png(width: 1200, height: 600), imageId: "image-a")
        guard case .loaded(let image) = fetched else { Issue.record("not loaded: \(fetched)"); return }
        #expect(image.imageId == "image-a")
        #expect(image.pixelSize == CGSize(width: 1200, height: 600))
        // The thumbnail is small enough to keep many of, and the same shape.
        #expect(max(image.thumbnail.width, image.thumbnail.height) == LoadedImage.thumbnailSide)
        #expect(image.thumbnail.width == 2 * image.thumbnail.height)
        #expect(image.full()?.width == 1200)

        #expect(ImageAPI.fetch(status: 404, body: Data(#"{"error":"not-found"}"#.utf8), imageId: "x") == .missing)
        #expect(ImageAPI.fetch(status: 200, body: Data("not an image".utf8), imageId: "x") == .missing)
        #expect(ImageAPI.fetch(status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8), imageId: "x") == .unavailable)
        #expect(ImageAPI.fetch(status: 503, body: Data(), imageId: "x") == .unavailable)
    }

    @Test("小さい画像は縮めない")
    func keepsASmallImage() {
        let image = Fixture.loaded("image-a", width: 40, height: 20)
        #expect(image.thumbnail.width == 40 && image.thumbnail.height == 20)
    }

    // MARK: - Keeping them

    @Test("同じ ID は 1 回だけ取りに行く。取れたものは手元のものを使う")
    func fetchesEachIdOnce() {
        var shelf = ImageShelf()
        #expect(shelf.request(["a", "b"]) == ["a", "b"])
        #expect(shelf["a"] == .loading)
        #expect(shelf.request(["a", "b", "c"]) == ["c"])
        shelf.receive("a", .loaded(Fixture.loaded("a")))
        #expect(shelf["a"] == .loaded(Fixture.loaded("a")))
        #expect(shelf.request(["a"]).isEmpty)
    }

    @Test("無い画像はもう取りに行かない。つながらなくて取れなかったものは、つながり直したら取り直す")
    func retriesOnlyWhatMayComeBack() {
        var shelf = ImageShelf()
        _ = shelf.request(["gone", "later"])
        shelf.receive("gone", .missing)
        shelf.receive("later", .unavailable)
        #expect(shelf.request(["gone", "later"]).isEmpty)
        shelf.retryUnavailable()
        #expect(shelf["later"] == nil)
        #expect(shelf["gone"] == .missing)
        #expect(shelf.request(["gone", "later"]) == ["later"])
    }

    @Test("頼んでいない画像の答え（ログアウトの前に出た取得など）は置かない")
    func dropsAnswersNotWaitedFor() {
        var shelf = ImageShelf()
        shelf.receive("a", .loaded(Fixture.loaded("a")))
        #expect(shelf["a"] == nil)
    }

    @Test("承認の画像は、その承認が承認待ちでなくなったら捨てる。会話の画像は残す")
    func dropsTheImagesOfClosedApprovals() {
        var shelf = ImageShelf()
        _ = shelf.request(["reply"])
        _ = shelf.request(["post-1", "post-2"], forApproval: true)
        shelf.receive("reply", .loaded(Fixture.loaded("reply")))
        shelf.receive("post-1", .loaded(Fixture.loaded("post-1")))
        shelf.keepApprovalImages(["post-2"])
        #expect(shelf["post-1"] == nil)
        #expect(shelf["post-2"] == .loading)
        #expect(shelf["reply"] != nil)
        // Asked for again while no approval shows it, it is not fetched.
        shelf.keepApprovalImages([])
        #expect(shelf["post-2"] == nil)
    }

    // MARK: - Sizes

    @Test("縮小画像は決まった高さで、幅は縦横の比から。比が分からないうちは正方形。極端な比は抑える")
    func sizesAtOneHeight() {
        let strip = ImageStrip(height: 60, maxWidth: 1000, spacing: 4)
        #expect(strip.sizes([2, 0.5, nil]) == [
            CGSize(width: 120, height: 60), CGSize(width: 30, height: 60), CGSize(width: 60, height: 60),
        ])
        #expect(strip.sizes([10, 0.1]) == [CGSize(width: 180, height: 60), CGSize(width: 20, height: 60)])
    }

    @Test("幅に収まらなければ、比を保ったまま全体を縮める")
    func shrinksToTheWidth() {
        let strip = ImageStrip(height: 100, maxWidth: 210, spacing: 10)
        // 200 + 100 + 10 does not fit in 210: the pictures take 200 of it, two thirds of what they wanted.
        let sizes = strip.sizes([2, 1])
        #expect(sizes.map(\.width) == [CGFloat(200) * 2 / 3, CGFloat(100) * 2 / 3])
        #expect(sizes.allSatisfy { abs($0.height - CGFloat(200) / 3) < 0.001 })
    }

    @Test("縮小画像の Props: 取る前から大きさがあり、取れたら画像、取れなければその印。取れたものだけ開ける")
    func tiles() {
        var shelf = ImageShelf()
        let images = [
            ShownImage(imageId: "a", mimeType: "image/png", bytes: 1, width: 200, height: 100),
            ShownImage(imageId: "b", mimeType: "image/png", bytes: 1),
            ShownImage(imageId: "c", mimeType: "image/png", bytes: 1),
        ]
        let strip = ImageStrip(height: 50, maxWidth: 1000, spacing: 0)
        let before = strip.tiles(images, shelf: shelf, openHelp: "クリックで拡大")
        #expect(before.map(\.size) == [CGSize(width: 100, height: 50), CGSize(width: 50, height: 50), CGSize(width: 50, height: 50)])
        #expect(before.map(\.content) == [.loading, .loading, .loading])
        #expect(before.map(\.label) == ["画像 1/3", "画像 2/3", "画像 3/3"])
        #expect(before.map(\.canOpen) == [false, false, false])
        #expect(before[0].help == "画像を読み込んでいます")

        _ = shelf.request(["a", "b", "c"])
        shelf.receive("a", .loaded(Fixture.loaded("a")))
        shelf.receive("b", .loaded(Fixture.loaded("b", width: 30, height: 60)))
        shelf.receive("c", .missing)
        let after = strip.tiles(images, shelf: shelf, openHelp: "クリックで拡大")
        #expect(after[0].content == .loaded(Fixture.loaded("a")))
        // The listed size keeps its place; one not listed takes the shape of what came.
        #expect(after[0].size == CGSize(width: 100, height: 50))
        #expect(after[1].size == CGSize(width: 25, height: 50))
        #expect(after[2].content == .failed)
        #expect(after[2].help == "画像を取れませんでした")
        #expect(after.map(\.canOpen) == [true, true, false])
        #expect(after[0].help == "クリックで拡大")
    }
}

import Foundation
import Testing
@testable import NatsumiCore

@Suite("本文の中の URL をリンクにする")
struct TextLinksTests {
    private func link(_ text: String) -> TextRun {
        .link(text, URL(string: text)!)
    }

    @Test("URL の無い本文は、そのまま 1 つの文字の並びになる")
    func plainText() {
        #expect(TextLinks.runs(in: "今日はいい天気") == [.plain("今日はいい天気")])
        #expect(TextLinks.runs(in: "") == [])
    }

    @Test("本文の中の http と https の URL をリンクにし、前後の文字はそのまま残す")
    func linksInText() {
        #expect(TextLinks.runs(in: "ここを見て https://example.com/a?b=1#c ね") == [
            .plain("ここを見て "), link("https://example.com/a?b=1#c"), .plain(" ね"),
        ])
        #expect(TextLinks.runs(in: "http://example.com") == [link("http://example.com")])
    }

    @Test("URL が複数あれば、それぞれをリンクにする")
    func severalLinks() {
        #expect(TextLinks.runs(in: "https://example.com と\nhttps://example.org/x") == [
            link("https://example.com"), .plain(" と\n"), link("https://example.org/x"),
        ])
    }

    @Test("日本語の文の中では、URL の直後の日本語の文字と全角の句読点・括弧を含めない")
    func japaneseAround() {
        #expect(TextLinks.runs(in: "詳しくはhttps://example.com/docsを見てね。") == [
            .plain("詳しくは"), link("https://example.com/docs"), .plain("を見てね。"),
        ])
        #expect(TextLinks.runs(in: "資料（https://example.com/a）です。") == [
            .plain("資料（"), link("https://example.com/a"), .plain("）です。"),
        ])
        #expect(TextLinks.runs(in: "「https://example.com」、https://example.org。") == [
            .plain("「"), link("https://example.com"), .plain("」、"), link("https://example.org"), .plain("。"),
        ])
    }

    @Test("末尾の半角の句読点と、対になっていない閉じ括弧は URL に含めない")
    func trailingPunctuation() {
        #expect(TextLinks.runs(in: "see https://example.com/a.") == [
            .plain("see "), link("https://example.com/a"), .plain("."),
        ])
        #expect(TextLinks.runs(in: "https://example.com/a, https://example.org!?") == [
            link("https://example.com/a"), .plain(", "), link("https://example.org"), .plain("!?"),
        ])
        #expect(TextLinks.runs(in: "(https://example.com/a)") == [
            .plain("("), link("https://example.com/a"), .plain(")"),
        ])
        // A bracket the URL opened itself is its own.
        #expect(TextLinks.runs(in: "https://example.com/wiki/Foo_(bar).") == [
            link("https://example.com/wiki/Foo_(bar)"), .plain("."),
        ])
    }

    @Test("http と https のほかはリンクにしない")
    func otherSchemes() {
        for text in [
            "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com", "mailto:someone@example.com",
            "example.com", "www.example.com",
        ] {
            #expect(TextLinks.runs(in: text) == [.plain(text)], "\(text)")
        }
    }

    @Test("ホストの無いものや、単語の途中から始まるものはリンクにしない")
    func notURLs() {
        #expect(TextLinks.runs(in: "https:// だけ") == [.plain("https:// だけ")])
        #expect(TextLinks.runs(in: "https:///path") == [.plain("https:///path")])
        #expect(TextLinks.runs(in: "xhttps://example.com") == [.plain("xhttps://example.com")])
    }

    @Test("大文字で書かれたスキームもリンクにし、書かれたとおりに出す")
    func upperCaseScheme() {
        #expect(TextLinks.runs(in: "HTTPS://Example.com/A") == [link("HTTPS://Example.com/A")])
    }

    @Test("途中で切った本文では、切れ目まで続く URL はリンクにしない")
    func cutText() {
        #expect(TextLinks.runs(in: "見て https://example.com/lo…", isCut: true) == [
            .plain("見て https://example.com/lo…"),
        ])
        #expect(TextLinks.runs(in: "https://example.com を見て、それから…", isCut: true) == [
            link("https://example.com"), .plain(" を見て、それから…"),
        ])
    }

    @Test("開いてよいのは http と https だけ")
    func openable() {
        #expect(TextLinks.canOpen(URL(string: "https://example.com")!))
        #expect(TextLinks.canOpen(URL(string: "HTTP://example.com")!))
        #expect(!TextLinks.canOpen(URL(string: "file:///etc/passwd")!))
        #expect(!TextLinks.canOpen(URL(string: "javascript:alert(1)")!))
    }
}

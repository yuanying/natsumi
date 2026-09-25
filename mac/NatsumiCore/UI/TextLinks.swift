import Foundation

/// A piece of a message's text: words as they are, or a URL drawn as a link to it.
public enum TextRun: Equatable, Sendable {
    case plain(String)
    /// The URL as it is written, and what it opens.
    case link(String, URL)
}

/// Where the URLs are in what she or the owner wrote, so that the views can draw them as links (ADR 0038).
///
/// Only `http` and `https` become links, and only when written out with the scheme. The scan is our own rather than
/// `NSDataDetector`'s: the detector links bare domains and other schemes, and its idea of where a URL ends next to
/// Japanese text is not ours to fix. A URL here is ASCII, so it ends at the first Japanese letter or full-width
/// mark (「。」「）」「」」 and the like), and a half-width mark that ends a sentence, or a closing bracket the URL did
/// not open itself, is left out of it.
public enum TextLinks {
    private static let schemes = ["https://", "http://"]
    /// What may be in a URL: printable ASCII, less the space and what RFC 3986 never allows in one.
    private static let excluded = Set("<>\"{}|\\^`")
    /// Half-width marks that end a sentence rather than a URL, when they come last.
    private static let trailing = Set(".,;:!?'*")
    private static let pairs: [Character: Character] = [")": "(", "]": "[", "}": "{"]

    /// The text in runs, in order; joined they are the text again. `isCut` says the text was cut short at its end, as
    /// a card's preview is: a URL that runs into the cut is not whole, so it is left as words.
    public static func runs(in text: String, isCut: Bool = false) -> [TextRun] {
        // The history is derived again at every event that may change it, every row of it. Most messages have no URL,
        // and they are passed over without the scan.
        guard mayHaveScheme(text) else { return text.isEmpty ? [] : [.plain(text)] }
        var runs: [TextRun] = []
        var plainStart = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            guard let found = url(in: text, at: index) else {
                index = text.index(after: index)
                continue
            }
            if isCut, reachesCut(text, from: found.end) {
                break
            }
            if plainStart < index { runs.append(.plain(String(text[plainStart..<index]))) }
            runs.append(.link(String(text[index..<found.end]), found.url))
            index = found.end
            plainStart = found.end
        }
        if plainStart < text.endIndex { runs.append(.plain(String(text[plainStart...]))) }
        return runs
    }

    /// Whether a link may be opened: the views are given no others, and the mediator checks again.
    public static func canOpen(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// The URL that starts at `start`, if one does.
    private static func url(in text: String, at start: String.Index) -> (url: URL, end: String.Index)? {
        guard text[start] == "h" || text[start] == "H" else { return nil }
        let head = text[start...].prefix(8).lowercased()
        guard let scheme = schemes.first(where: { head.hasPrefix($0) }) else { return nil }
        // The scheme starts a word: "xhttps://" is not a URL, but "詳しくはhttps://" is.
        if start > text.startIndex {
            let before = text[text.index(before: start)]
            if before.isASCII, before.isLetter || before.isNumber { return nil }
        }
        var end = text.index(start, offsetBy: scheme.count)
        let hostStart = end
        while end < text.endIndex, isURLCharacter(text[end]) { end = text.index(after: end) }
        end = trimmed(text, from: hostStart, to: end)
        guard end > hostStart, text[hostStart] != "/",
              let url = URL(string: String(text[start..<end])), url.host?.isEmpty == false, canOpen(url)
        else { return nil }
        return (url, end)
    }

    /// Whether "http" is written somewhere in the text, in any case: looked for in its bytes, where it is quick.
    private static func mayHaveScheme(_ text: String) -> Bool {
        var text = text
        return text.withUTF8 { bytes in
            guard bytes.count >= 4 else { return false }
            // `| 0x20` lowers an ASCII letter; the bytes of other characters are all above ASCII and match nothing.
            for index in 0...(bytes.count - 4) where bytes[index] | 0x20 == UInt8(ascii: "h") {
                if bytes[index + 1] | 0x20 == UInt8(ascii: "t"), bytes[index + 2] | 0x20 == UInt8(ascii: "t"),
                   bytes[index + 3] | 0x20 == UInt8(ascii: "p") {
                    return true
                }
            }
            return false
        }
    }

    private static func isURLCharacter(_ character: Character) -> Bool {
        guard character.isASCII, let scalar = character.unicodeScalars.first else { return false }
        return scalar.value > 0x20 && scalar.value < 0x7F && !excluded.contains(character)
    }

    /// The end of the URL once what ends the sentence around it is taken off.
    private static func trimmed(_ text: String, from start: String.Index, to end: String.Index) -> String.Index {
        var end = end
        while end > start {
            let last = text[text.index(before: end)]
            if trailing.contains(last) {
                end = text.index(before: end)
            } else if let open = pairs[last] {
                let body = text[start..<text.index(before: end)]
                guard body.filter({ $0 == open }).count <= body.filter({ $0 == last }).count else { break }
                end = text.index(before: end)
            } else {
                break
            }
        }
        return end
    }

    /// Nothing but the mark of the cut comes after `index`.
    private static func reachesCut(_ text: String, from index: String.Index) -> Bool {
        text[index...].allSatisfy { $0 == "…" }
    }
}

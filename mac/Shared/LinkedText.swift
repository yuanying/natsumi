import NatsumiCore
import SwiftUI

extension AttributedString {
    /// A message's text with its URLs as links, underlined so they read as links whatever the colors around them
    /// (ADR 0038). Which parts are links is decided in `NatsumiCore`; this only draws them.
    init(runs: [TextRun]) {
        self.init()
        for run in runs {
            switch run {
            case .plain(let text):
                append(AttributedString(text))
            case .link(let text, let url):
                var link = AttributedString(text)
                link.link = url
                link.swiftUI.underlineStyle = .single
                append(link)
            }
        }
    }
}

extension View {
    /// A click or tap on a link in here is raised through `sink` instead of being opened on the spot: opening it is
    /// the mediator's to decide, like everything else the owner does (ADR 0038).
    func opensLinks<Event>(through sink: EventSinkOf<Event>, as event: @escaping (URL) -> Event) -> some View {
        environment(\.openURL, OpenURLAction { url in
            sink(event(url))
            return .handled
        })
    }
}

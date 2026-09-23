import NatsumiCore

/// The login screen: the server field and 「GitHub でログイン」.
@MainActor
final class LoginComponent: PhoneComponent {
    init() {
        super.init(name: "login")
    }
}

/// The main screen. Each part that raises something is a child of its own, so an event says where it came from.
/// The main screen raises the closing of a page itself: it is what the pages are pushed over.
@MainActor
final class MainComponent: PhoneComponent {
    /// The status at the top, when it offers to connect again.
    let status = PhoneComponent(name: "main.status")
    /// The history and settings buttons at the top right.
    let header = PhoneComponent(name: "main.header")
    /// The notice card, which opens the history.
    let notices = PhoneComponent(name: "main.notices")
    /// The × on her reply.
    let balloon = PhoneComponent(name: "main.balloon")
    /// The text field and the send button.
    let input = PhoneComponent(name: "main.input")
    /// The messages that could not be recorded, each with its ×.
    let failures = PhoneComponent(name: "main.failures")

    init() {
        super.init(name: "main")
        adopt(status)
        adopt(header)
        adopt(notices)
        adopt(balloon)
        adopt(input)
        adopt(failures)
    }
}

/// The history, pushed over the main screen.
@MainActor
final class HistoryComponent: PhoneComponent {
    /// The rows, which report coming into sight and going out of it.
    let rows = PhoneComponent(name: "history.rows")
    /// The text field and the send button under the history.
    let input = PhoneComponent(name: "history.input")
    /// The messages not recorded yet, each with its × when it failed.
    let outgoing = PhoneComponent(name: "history.outgoing")

    init() {
        super.init(name: "history")
        adopt(rows)
        adopt(input)
        adopt(outgoing)
    }
}

/// The settings, pushed over the main screen.
@MainActor
final class SettingsComponent: PhoneComponent {
    /// Logging out, and connecting again when the connection offers it.
    let buttons = PhoneComponent(name: "settings.buttons")

    init() {
        super.init(name: "settings")
        adopt(buttons)
    }
}

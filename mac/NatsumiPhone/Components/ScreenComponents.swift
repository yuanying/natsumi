import NatsumiCore

/// The login screen: the server field and 「GitHub でログイン」.
@MainActor
final class LoginComponent: PhoneComponent {
    init() {
        super.init(name: "login")
    }
}

/// The main screen. Each part that raises something is a child of its own, so an event says where it came from.
@MainActor
final class MainComponent: PhoneComponent {
    /// The status at the top, when it offers to connect again.
    let status = PhoneComponent(name: "main.status")
    /// The × on her reply.
    let balloon = PhoneComponent(name: "main.balloon")
    /// The text field and the send button.
    let input = PhoneComponent(name: "main.input")
    /// The messages that could not be recorded, each with its ×.
    let failures = PhoneComponent(name: "main.failures")

    init() {
        super.init(name: "main")
        adopt(status)
        adopt(balloon)
        adopt(input)
        adopt(failures)
    }
}

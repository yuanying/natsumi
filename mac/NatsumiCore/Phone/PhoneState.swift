import Foundation

/// Everything the iPhone's UI is, in one value. Only the mediator changes it, and every drawing parameter is derived
/// from it.
public struct PhoneState {
    /// The connection and the conversation, as on the Mac.
    var session: SessionMachine

    public internal(set) var status: ConnectionStatus = .needsServer
    public internal(set) var hasSession = false
    public internal(set) var serverOrigin: String?
    /// What the login screen says about the server entered or the login that did not go through.
    public internal(set) var loginMessage: String?
    public internal(set) var avatar = AvatarArt.placeholder

    /// The page over the main screen, if one is open.
    public internal(set) var page: PhonePage?
    /// The rows of the history in sight, by message ID, while the history is open.
    var visibleHistoryIds: Set<String> = []

    public var conversation: ConversationState { session.conversation }

    /// The owner is reading the history: what is in sight there is read and checked.
    public var isReadingHistory: Bool { hasSession && page == .history }

    init(session: SessionMachine) {
        self.session = session
    }
}

/// A page pushed over the main screen.
public enum PhonePage: Equatable, Sendable {
    case history
    case settings
}

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

    public var conversation: ConversationState { session.conversation }

    init(session: SessionMachine) {
        self.session = session
    }
}

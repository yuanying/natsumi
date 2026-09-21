import Foundation

/// What the mediator asks the world outside to do. The mediator never does any of it: the root's adapters run these
/// and report back with events.
public enum UIEffect: Equatable, Sendable {
    // MARK: The connection (the session machine's own effects, passed on)

    case connect
    /// Close the socket and cancel a reconnect that is waiting.
    case disconnect
    case sendToServer(ClientEnvelope)
    case saveDeviceId(String)
    case clearSession
    case scheduleReconnect(after: TimeInterval)

    // MARK: Storage and login

    /// Look for a live session and answer with `.sessionResumed`.
    case resumeSession
    case startLogin
    case logout
    case saveServerAddress(ServerAddress)
    case saveCharacterScale(CharacterScale)
    case saveConversationWindow(ConversationWindow)
    /// nil saves that there is no shortcut.
    case saveHotKey(HotKey?)
    /// nil puts the setting back to the default directory.
    case saveAvatarDirectory(String?)
    /// Read the avatar and answer with `.avatarLoaded`.
    case loadAvatar(directory: String)

    // MARK: Panels, keyboard and the app

    /// Make the conversation window key and put the caret in the text field.
    case focusInput
    /// Run the character to this place, and answer with `.characterMoveFinished`.
    case moveCharacter(to: CGPoint)
    /// Stop a run in flight and leave her where it got to. Nothing is answered: whoever stopped it decides what
    /// happens next.
    case stopCharacterMove
    /// Remember where she stands as the place she starts in next time.
    case saveCharacterPlace
    /// Watch the pointer around this rectangle and report when it settles by it or leaves it; nil stops watching.
    case watchPointer(near: CGRect?)
    /// Register this as the global shortcut in place of the one before, or register none. A shortcut the system
    /// will not take is answered with `.hotKeyRegistrationFailed`.
    case registerHotKey(HotKey?)
    case showSettings
    case hideSettings
    case terminate
}

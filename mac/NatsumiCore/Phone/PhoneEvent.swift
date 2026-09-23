import Foundation

/// Everything that can happen to the iPhone's UI: what the owner does, and what the world outside reports.
///
/// As on the Mac, both enter the tree the same way and end at one mediator (ADR 0028). The iPhone has no character
/// to drag, no windows and no shortcut, so it has its own, smaller set.
public enum PhoneEvent: Equatable, Sendable {
    // MARK: The app and the world outside

    /// The server the owner set, or nil when there is none yet.
    case launched(serverOrigin: String?)
    /// The answer to `.resumeSession`: whether a live session is in the Keychain, and the device this iPhone registered.
    case sessionResumed(hasSession: Bool, deviceId: String?)
    /// The server or the session went missing while connecting.
    case credentialsMissing
    case avatarLoaded(AvatarArt)
    case loginFinished(LoginOutcome)
    case socketOpened
    case socketReceived(Data)
    case socketClosed(CloseReason)
    case reconnectTimerFired
    /// The app came to the front. iOS stops what an app does behind others, so the connection is taken up again here.
    case becameActive
    /// The app went behind others, where iOS will soon stop it.
    case enteredBackground

    // MARK: The login screen

    /// 「GitHub でログイン」 with the server as the owner wrote it.
    case loginSubmitted(server: String)

    // MARK: The main screen

    /// The status at the top, when it offers to connect again.
    case reconnectRequested
    /// The history button at the top right, or the notice card.
    case historyOpenRequested
    /// The settings button at the top right.
    case settingsOpenRequested
    /// Back from the history or the settings, by the button or by the swipe.
    case pageClosed
    /// The × on her reply.
    case balloonCloseTapped
    /// The owner is in the text field, or has left it: the keyboard is up or gone (ADR 0028).
    case inputFocusChanged(Bool)
    case inputSubmitted(String)
    case outgoingDismissed(requestId: String)

    // MARK: The history and the settings

    /// A row of the history came into sight or went out of it.
    case historyRowVisibilityChanged(messageId: String, isVisible: Bool)
    case logoutRequested
}

/// What the iPhone's mediator asks the world outside to do. The root runs these and reports back with events.
public enum PhoneEffect: Equatable, Sendable {
    // MARK: The connection (the session machine's own effects, passed on)

    case connect
    /// Close the socket and cancel a reconnect that is waiting.
    case disconnect
    case sendToServer(ClientEnvelope)
    case saveDeviceId(String)
    case clearSession
    case scheduleReconnect(after: TimeInterval)

    // MARK: Storage, login and the avatar

    /// Look for a live session and answer with `.sessionResumed`.
    case resumeSession
    case startLogin
    case saveServerAddress(ServerAddress)
    /// Tell the server the session is over and forget it here.
    case logout
    /// Read the avatar bundled with the app and answer with `.avatarLoaded`.
    case loadAvatar
}

/// The iPhone's tree.
public typealias PhoneComponent = TreeComponent<PhoneEvent>
public typealias PhoneEventSink = EventSinkOf<PhoneEvent>

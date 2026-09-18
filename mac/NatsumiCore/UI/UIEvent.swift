import CoreGraphics
import Foundation

/// What the app knows about itself when it starts: the settings it saved and where the avatar comes from.
public struct LaunchInfo: Equatable, Sendable {
    public var characterScale: CharacterScale
    public var inputBoxSize: InputBoxSize
    /// The server the owner set, or nil when there is none yet.
    public var serverOrigin: String?
    public var avatarDirectory: String
    public var defaultAvatarDirectory: String

    public init(
        characterScale: CharacterScale, inputBoxSize: InputBoxSize, serverOrigin: String?,
        avatarDirectory: String, defaultAvatarDirectory: String
    ) {
        self.characterScale = characterScale
        self.inputBoxSize = inputBoxSize
        self.serverOrigin = serverOrigin
        self.avatarDirectory = avatarDirectory
        self.defaultAvatarDirectory = defaultAvatarDirectory
    }
}

/// How the browser sheet of the GitHub login ended.
public enum LoginOutcome: Equatable, Sendable {
    case succeeded
    case cancelled
    case failed(String)
}

/// Everything that can happen to the UI: what the owner does, and what the world outside reports.
///
/// Both enter the tree the same way. The owner's doings are raised by the component they happened in and bubble to
/// the root; the world's are handed to the root by the adapters. There is one entrance, and it is the mediator.
public enum UIEvent: Equatable, Sendable {
    // MARK: The app and the world outside

    case launched(LaunchInfo)
    /// The answer to `.resumeSession`: whether a live session is in the Keychain, and the device this Mac registered.
    case sessionResumed(hasSession: Bool, deviceId: String?)
    /// The server or the session went missing while connecting.
    case credentialsMissing
    case avatarLoaded(AvatarArt, description: String)
    case loginFinished(LoginOutcome)
    case socketOpened
    case socketReceived(Data)
    case socketClosed(CloseReason)
    case reconnectTimerFired

    // MARK: The character

    case characterClicked
    /// The yellow count at the character's top right.
    case badgeClicked

    // MARK: The balloon

    case balloonTextClicked
    case balloonCloseClicked

    // MARK: The notices

    case noticeTextClicked
    case noticeCloseClicked

    /// "続きは履歴で", under a reply or a notice.
    case historyLinkClicked

    // MARK: The input field

    case inputSubmitted(String)
    case inputEscaped
    case clickedOutsideApp
    case historyButtonClicked
    case outgoingDismissed(requestId: String)
    /// How tall the text has become, as the text view measured it.
    case inputTextHeightMeasured(CGFloat)
    /// The grip in the bottom-right corner, with the mouse in screen coordinates.
    case gripDragged(to: CGPoint)
    case gripReleased

    // MARK: The history

    case historyCloseRequested

    // MARK: The menus and the settings

    case talkRequested
    case historyOpenRequested
    case readAllRepliesRequested
    case acknowledgeAllNoticesRequested
    case loginRequested
    case logoutRequested
    case reconnectRequested
    case settingsOpenRequested
    case settingsCloseRequested
    case serverSubmitted(String)
    case characterScaleChanged(CharacterScale)
    case avatarDirectorySubmitted(String)
    case avatarDirectoryResetRequested
    case quitRequested
}

import CoreGraphics
import Foundation

/// Where the connection to the server stands, as the owner is told about it.
public enum ConnectionStatus: Equatable, Sendable {
    case needsServer
    case needsLogin
    case loggingIn
    case connecting
    case connected
    case reconnecting
    case unavailable(String)
    /// A newer connection of this device took over.
    case replaced
    case stopped

    public var text: String {
        switch self {
        case .needsServer: "サーバーが未設定です"
        case .needsLogin: "ログインが必要です"
        case .loggingIn: "ログイン中…"
        case .connecting: "接続中…"
        case .connected: "接続しています"
        case .reconnecting: "再接続を待っています"
        case .unavailable(let code): "会話を使えません（\(code)）"
        case .replaced: "この端末の別の接続に切り替わりました"
        case .stopped: "接続を止めました"
        }
    }
}

/// The card whose whole text is shown. Only one is open at a time: opening another folds the one before.
public enum ExpandedCard: Equatable, Sendable {
    case reply(String)
    case notice(String)
}

/// Where the grip was taken hold of, so that a drag is measured from there.
struct GripAnchor: Equatable {
    var mouse: CGPoint
    var size: InputBoxSize
}

/// Everything the UI is, in one value. Only the mediator changes it, and every drawing parameter is derived from
/// it; nothing else is kept anywhere in the tree.
public struct UIState {
    /// The connection and the conversation. The mediator hands the connection's own decisions to this machine and
    /// passes its effects on; what the owner sees is decided here.
    var session: SessionMachine

    public internal(set) var status: ConnectionStatus = .needsServer
    public internal(set) var hasSession = false
    public internal(set) var serverOrigin: String?
    public internal(set) var lastError: String?
    /// What the settings panel says about the server the owner just entered.
    public internal(set) var settingsMessage: String?

    public internal(set) var isInputOpen = false
    public internal(set) var isHistoryOpen = false
    public internal(set) var isSettingsOpen = false

    public internal(set) var characterScale = CharacterScale.default
    public internal(set) var inputBoxSize = InputBoxSize.default
    /// How tall the text in the input field is, as the text view measured it.
    public internal(set) var inputTextHeight: CGFloat = 0

    /// Where the character stands and which screen she is on, as the root last reported them. The mediator works
    /// out where she should go from these; it never asks the screen itself.
    public internal(set) var characterFrame: CGRect = .zero
    public internal(set) var visibleFrame: CGRect = .zero
    /// What she is doing, over and above her face.
    public internal(set) var motion: CharacterMotion = .still
    /// The way she last went sideways. Straight up and straight down keep it.
    var facing: RunDirection = .right
    var isDragging = false
    var isMoving = false
    /// Where she stood before she stepped out of the pointer's way. nil while she is in her own place, and her own
    /// place is never overwritten while this is set.
    var dodgeHome: CGPoint?
    /// How far she is standing from her own place to give the column room. It is measured from her place, not from
    /// where she is, so the same room is never asked for twice and she comes back when it is no longer needed.
    public internal(set) var columnOffset: CGFloat = 0
    /// The rectangle the root watches the pointer around, so that the same one is not asked for twice.
    var watchedPointerRect: CGRect?

    public internal(set) var avatar = AvatarArt.placeholder
    public internal(set) var avatarDescription = ""
    public internal(set) var avatarDirectory = ""
    public internal(set) var defaultAvatarDirectory = ""

    /// The card the owner opened to read in full. It folds by itself when that card is no longer at the front.
    public internal(set) var expanded: ExpandedCard?
    /// The indicator the owner closed. It stays closed until the balloon would say something else.
    var dismissedIndicator: BalloonIndicator?
    /// The badge hid the bundle. Hiding checks nothing, and a notice not seen before brings it back.
    var noticesHidden = false
    var seenNoticeIds: Set<String> = []
    var gripAnchor: GripAnchor?

    public var conversation: ConversationState { session.conversation }

    /// She is standing somewhere other than her own place, for the pointer or for the column. Her own place must
    /// not be overwritten while she is.
    public var isSteppedAside: Bool { dodgeHome != nil || columnOffset != 0 }

    init(session: SessionMachine) {
        self.session = session
    }
}

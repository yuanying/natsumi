import NatsumiCore
import Observation

/// How the menu bar's SwiftUI scene is given its drawing parameters. It holds nothing but the props and the port
/// the menu raises its events through; the scene cannot be handed a new value from outside the way a panel can.
@MainActor
@Observable
final class MenuBarModel {
    var props = MenuProps(
        statusText: ConnectionStatus.needsServer.text, canReadAllReplies: false, canAcknowledgeAllNotices: false,
        showsLogin: false, canLogout: false)
    @ObservationIgnored var send: EventSink = .ignored
}

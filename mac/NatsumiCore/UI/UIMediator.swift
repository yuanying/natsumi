import CoreGraphics
import Foundation

/// The state machine the whole UI is arbitrated by: `(State, Event) -> (State, [Effect])`.
///
/// It knows nothing of AppKit, SwiftUI, the network, the preferences or the Keychain. Every event, whether the
/// owner raised it in a component or an adapter reported it from outside, is settled here, and everything that has
/// to happen out in the world leaves as an effect for the root to run. The connection is not its concern: it hands
/// that to `SessionMachine` and passes the machine's effects on as its own.
public struct UIMediator {
    public private(set) var state: UIState
    private let makeRequestId: () -> String

    public init(makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.makeRequestId = makeRequestId
        self.state = UIState(session: SessionMachine(deviceId: nil, makeRequestId: makeRequestId))
    }

    public mutating func handle(_ event: UIEvent) -> [UIEffect] {
        let effects = decide(event)
        settle()
        return effects
    }

    // MARK: - Deciding

    private mutating func decide(_ event: UIEvent) -> [UIEffect] {
        switch event {
        // MARK: The app and the world outside
        case .launched(let info):
            state.characterScale = info.characterScale
            state.inputBoxSize = info.inputBoxSize
            state.serverOrigin = info.serverOrigin
            state.avatarDirectory = info.avatarDirectory
            state.defaultAvatarDirectory = info.defaultAvatarDirectory
            return [.loadAvatar(directory: info.avatarDirectory)] + resume()

        case .sessionResumed(let hasSession, let deviceId):
            state.hasSession = hasSession
            guard state.serverOrigin != nil else {
                state.status = .needsServer
                return []
            }
            guard hasSession else {
                state.status = .needsLogin
                return []
            }
            state.session = SessionMachine(deviceId: deviceId, makeRequestId: makeRequestId)
            return apply(state.session.start())

        case .credentialsMissing:
            _ = state.session.stop()
            state.hasSession = false
            state.status = .needsLogin
            return [.disconnect]

        case .avatarLoaded(let art, let description):
            state.avatar = art
            state.avatarDescription = description
            return []

        case .loginFinished(.succeeded):
            state.lastError = nil
            return resume()

        case .loginFinished(.cancelled):
            state.status = .needsLogin
            return []

        case .loginFinished(.failed(let message)):
            state.lastError = message
            state.status = .needsLogin
            return []

        case .socketOpened:
            return apply(state.session.connected())

        case .socketReceived(let data):
            return apply(state.session.received(data))

        case .socketClosed(let reason):
            return apply(state.session.closed(reason))

        case .reconnectTimerFired:
            return apply(state.session.reconnectTimerFired())

        // MARK: The character and the panels
        case .characterClicked:
            return state.isInputOpen ? closeInput() : openInput()

        case .talkRequested:
            return openInput()

        case .inputEscaped, .clickedOutsideApp:
            return closeInput()

        case .characterFrameChanged(let frame, let visible):
            let before = state.characterFrame
            state.characterFrame = frame
            state.visibleFrame = visible
            // A run of her own moves her frame step by step; where the pointer is watched settles when she arrives.
            guard state.isDragging else { return state.isMoving ? [] : watchPointer() }
            // The owner is carrying her: she runs the way she is being carried.
            state.facing = CharacterRun.facing(from: before.origin, to: frame.origin, keeping: state.facing)
            state.motion = .running(state.facing)
            return []

        case .characterDragBegan:
            guard !state.isDragging else { return [] }
            state.isDragging = true
            // The owner's hand wins over anything she was doing: wherever she was running to no longer matters, and
            // standing out of the pointer's way is over, because she is being put somewhere on purpose.
            state.isMoving = false
            state.dodgeHome = nil
            state.motion = .running(state.facing)
            return [.stopCharacterMove] + watchPointer()

        case .characterDragEnded:
            guard state.isDragging else { return [] }
            state.isDragging = false
            state.motion = .still
            // Wherever the owner let go of her is her place now.
            state.dodgeHome = nil
            return [.saveCharacterPlace] + watchPointer()

        case .characterMoveFinished:
            state.isMoving = false
            // A run the owner took over from ends without a word: she is in their hand now, still running.
            guard !state.isDragging else { return [] }
            state.motion = .still
            // Stepping aside is only for as long as the pointer is there, so it does not become her place.
            return (state.dodgeHome == nil ? [.saveCharacterPlace] : []) + watchPointer()

        case .screenConfigurationChanged(let visible):
            state.visibleFrame = visible
            state.dodgeHome = nil
            let frame = OverlayLayout.clamp(state.characterFrame, into: visible)
            guard frame.origin != state.characterFrame.origin else { return watchPointer() }
            return run(to: frame.origin)

        case .columnNeedsRoom(let offset):
            // She keeps the place she makes for the column: coming back every time it shrinks would have her
            // stepping up and down with every reply. Only the pointer moves her for a while.
            guard !state.isDragging, !state.isMoving, state.dodgeHome == nil, offset != 0 else { return [] }
            var frame = state.characterFrame
            frame.origin.y += offset
            frame = OverlayLayout.clamp(frame, into: state.visibleFrame)
            guard frame.origin != state.characterFrame.origin else { return [] }
            return run(to: frame.origin)

        case .pointerCameNear(let pointer):
            guard !state.isInputOpen, !state.isDragging, !state.isMoving, state.dodgeHome == nil else { return [] }
            guard let origin = PointerDodge.target(
                character: state.characterFrame, pointer: pointer, visible: state.visibleFrame)
            else { return [] }
            state.dodgeHome = state.characterFrame.origin
            return run(to: origin) + watchPointer()

        case .pointerWentAway:
            guard let home = state.dodgeHome else { return [] }
            state.dodgeHome = nil
            return run(to: home)

        case .badgeClicked:
            guard UIProps.noticeStack(state.conversation) != nil else { return [] }
            state.noticesHidden.toggle()
            return []

        case .historyOpenRequested, .historyButtonClicked, .historyLinkClicked:
            guard !state.isHistoryOpen else { return [] }
            state.isHistoryOpen = true
            return [.makeHistoryKey]

        case .historyCloseRequested:
            state.isHistoryOpen = false
            return []

        case .settingsOpenRequested:
            state.isSettingsOpen = true
            return [.showSettings]

        case .settingsCloseRequested:
            state.isSettingsOpen = false
            return [.hideSettings]

        case .quitRequested:
            return [.terminate]

        // MARK: The conversation
        case .inputSubmitted(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return apply(state.session.send(text: text))

        case .outgoingDismissed(let requestId):
            state.session.dismiss(requestId: requestId)
            return []

        case .balloonTextClicked:
            // Opening a reply reads nothing: only the × tells the server anything.
            guard let front = UIProps.replyStack(state.conversation)?.front else { return [] }
            open(.reply(front.messageId))
            return []

        case .balloonCloseClicked:
            // The × reads the reply at the front and brings the next one forward; on "受付中" and "考え中" there is
            // nothing to read, so it only hides them.
            guard UIProps.replyStack(state.conversation) != nil else {
                state.dismissedIndicator = UIProps.indicator(state.conversation)
                return []
            }
            return apply(state.session.confirmFrontReply())

        case .readAllRepliesRequested:
            return apply(state.session.confirmAllReplies())

        case .noticeTextClicked:
            guard let stack = UIProps.noticeStack(state.conversation) else { return [] }
            switch stack.front {
            case .notice(let message):
                open(.notice(message.messageId))
                return []
            case .older(let ids):
                // The card has no text to open, so a click on it still checks the notices it stands for.
                return apply(state.session.acknowledge(ids))
            }

        case .noticeCloseClicked:
            guard let ids = UIProps.noticeStack(state.conversation)?.frontIds else { return [] }
            return apply(state.session.acknowledge(ids))

        case .acknowledgeAllNoticesRequested:
            return apply(state.session.acknowledgeAllNotices())

        // MARK: Login, logout and the server
        case .loginRequested:
            guard state.serverOrigin != nil else {
                state.status = .needsServer
                return []
            }
            state.status = .loggingIn
            return [.startLogin]

        case .logoutRequested:
            _ = state.session.stop()
            state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
            state.hasSession = false
            state.status = state.serverOrigin == nil ? .needsServer : .needsLogin
            return [.disconnect, .logout]

        case .reconnectRequested:
            return resume()

        case .serverSubmitted(let text):
            do {
                let address = try ServerAddress(text)
                state.settingsMessage = "保存しました"
                guard address.origin.absoluteString != state.serverOrigin else { return [] }
                state.serverOrigin = address.origin.absoluteString
                state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
                return [.saveServerAddress(address)] + resume()
            } catch ServerAddressError.insecure {
                state.settingsMessage = "http は localhost などのループバックだけで使えます。https の URL を入れてください"
            } catch {
                state.settingsMessage = "https://ホスト名[:ポート] の形で入れてください"
            }
            return []

        // MARK: The size of things and the avatar
        case .characterScaleChanged(let scale):
            guard scale != state.characterScale else { return [] }
            state.characterScale = scale
            return [.saveCharacterScale(scale)]

        case .inputTextHeightMeasured(let height):
            guard height != state.inputTextHeight else { return [] }
            state.inputTextHeight = height
            return []

        case .gripDragged(let mouse):
            let anchor = state.gripAnchor ?? GripAnchor(mouse: mouse, size: state.inputBoxSize)
            state.gripAnchor = anchor
            // Dragging right widens the box on both sides (it stays centered under the character); down makes the
            // text area taller.
            let size = InputBoxSize(
                width: anchor.size.width + (mouse.x - anchor.mouse.x) * 2,
                height: anchor.size.height + (anchor.mouse.y - mouse.y))
            guard size != state.inputBoxSize else { return [] }
            state.inputBoxSize = size
            return [.saveInputBoxSize(size)]

        case .gripReleased:
            state.gripAnchor = nil
            return []

        case .avatarDirectorySubmitted(let path):
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            let saved: String? = trimmed.isEmpty || trimmed == state.defaultAvatarDirectory ? nil : trimmed
            state.avatarDirectory = saved ?? state.defaultAvatarDirectory
            return [.saveAvatarDirectory(saved), .loadAvatar(directory: state.avatarDirectory)]

        case .avatarDirectoryResetRequested:
            state.avatarDirectory = state.defaultAvatarDirectory
            return [.saveAvatarDirectory(nil), .loadAvatar(directory: state.avatarDirectory)]
        }
    }

    // MARK: - The pieces the decisions are made of

    /// Sends her running to a place, facing the way she goes.
    private mutating func run(to origin: CGPoint) -> [UIEffect] {
        state.facing = CharacterRun.facing(from: state.characterFrame.origin, to: origin, keeping: state.facing)
        state.motion = .running(state.facing)
        state.isMoving = true
        return [.moveCharacter(to: origin)]
    }

    /// Asks for the pointer to be watched around the place she would come back to, and not at all while the owner
    /// is holding her or has the input field open. Watching where she comes back to, rather than where she stands,
    /// is what keeps her from setting off again the moment she lands.
    private mutating func watchPointer() -> [UIEffect] {
        var rect: CGRect?
        if !state.isInputOpen, !state.isDragging, !state.characterFrame.isEmpty {
            rect = CGRect(origin: state.dodgeHome ?? state.characterFrame.origin, size: state.characterFrame.size)
        }
        guard rect != state.watchedPointerRect else { return [] }
        state.watchedPointerRect = rect
        return [.watchPointer(near: rect)]
    }

    /// Opens a card to its whole text, or folds it when it is the one already open. Only one is open at a time.
    private mutating func open(_ card: ExpandedCard) {
        state.expanded = state.expanded == card ? nil : card
    }

    /// Drops the connection and asks whether there is still a session to come back with.
    private mutating func resume() -> [UIEffect] {
        _ = state.session.stop()
        guard state.serverOrigin != nil else {
            state.status = .needsServer
            return [.disconnect]
        }
        return [.disconnect, .resumeSession]
    }

    /// The input field opens right under her, so she stays put while it is open: a pointer on its way to it must
    /// not send her running.
    private mutating func openInput() -> [UIEffect] {
        guard !state.isInputOpen else { return [] }
        state.isInputOpen = true
        return [.focusInput, .watchOutsideClicks(true)] + watchPointer()
    }

    private mutating func closeInput() -> [UIEffect] {
        guard state.isInputOpen else { return [] }
        state.isInputOpen = false
        return [.watchOutsideClicks(false)] + watchPointer()
    }

    /// Passes the session machine's effects on as the mediator's own, and reads the connection's state off it.
    private mutating func apply(_ effects: [SessionEffect]) -> [UIEffect] {
        var out: [UIEffect] = []
        for effect in effects {
            switch effect {
            case .connect: out.append(.connect)
            case .disconnect: out.append(.disconnect)
            case .send(let envelope): out.append(.sendToServer(envelope))
            case .saveDeviceId(let id): out.append(.saveDeviceId(id))
            case .requireLogin:
                state.hasSession = false
                out += [.disconnect, .clearSession]
            case .scheduleReconnect(let delay):
                out += [.disconnect, .scheduleReconnect(after: delay)]
            }
        }
        switch state.session.phase {
        case .idle: break
        case .connecting, .syncing: state.status = .connecting
        case .ready: state.status = .connected
        case .waitingToReconnect: state.status = .reconnecting
        case .unavailable(let code): state.status = .unavailable(code)
        case .loginRequired: state.status = .needsLogin
        case .replaced: state.status = .replaced
        case .stopped: state.status = .stopped
        }
        return out
    }

    /// What the conversation now says about the indicator the owner closed and the bundle the badge hid.
    private mutating func settle() {
        let candidate = UIProps.replyStack(state.conversation) == nil ? UIProps.indicator(state.conversation) : nil
        if candidate != state.dismissedIndicator { state.dismissedIndicator = nil }

        // A card that is no longer at the front folds by itself; what is open is always what is shown.
        switch state.expanded {
        case .reply(let id):
            if UIProps.replyStack(state.conversation)?.front.messageId != id { state.expanded = nil }
        case .notice(let id):
            if case .notice(let front) = UIProps.noticeStack(state.conversation)?.front, front.messageId == id {
            } else {
                state.expanded = nil
            }
        case nil:
            break
        }

        let ids = state.conversation.unacknowledgedNotificationIds
        if ids.contains(where: { !state.seenNoticeIds.contains($0) }) { state.noticesHidden = false }
        state.seenNoticeIds.formUnion(ids)
        if UIProps.noticeStack(state.conversation) == nil { state.noticesHidden = false }
    }
}

import Foundation

/// The state machine the iPhone's UI is arbitrated by: `(State, Event) -> (State, [Effect])` (ADR 0028).
///
/// Like the Mac's `UIMediator`, it does no I/O: what has to happen out in the world leaves as an effect for the root
/// to run. The connection is `SessionMachine`'s, and what is read and shown follows the Mac's rules (ADR 0022,
/// ADR 0025), so both clients agree on what the owner has seen.
public struct PhoneMediator {
    public private(set) var state: PhoneState
    private let makeRequestId: () -> String

    public init(makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.makeRequestId = makeRequestId
        self.state = PhoneState(session: SessionMachine(deviceId: nil, makeRequestId: makeRequestId))
    }

    public mutating func handle(_ event: PhoneEvent) -> [PhoneEffect] {
        switch event {
        // MARK: The app and the world outside
        case .launched(let serverOrigin):
            state.serverOrigin = serverOrigin
            return [.loadAvatar] + resume()

        case .sessionResumed(let hasSession, let deviceId):
            // A session is for a server; without one there is nothing to use it with, and only the login to show.
            state.hasSession = hasSession && state.serverOrigin != nil
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

        case .avatarLoaded(let art):
            state.avatar = art
            return []

        case .loginFinished(.succeeded):
            state.loginMessage = nil
            return resume()

        case .loginFinished(.cancelled):
            state.status = .needsLogin
            return []

        case .loginFinished(.failed(let message)):
            state.loginMessage = message
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

        case .becameActive:
            // The same machine goes on, so the sync resumes from where the stream was and nothing unsent is lost.
            guard state.hasSession else { return [] }
            switch state.session.phase {
            case .idle, .replaced, .stopped, .unavailable:
                return [.disconnect] + apply(state.session.start())
            case .waitingToReconnect:
                // The wait was for a network that failed; the owner is here now, so it is tried at once.
                return [.disconnect] + apply(state.session.reconnectTimerFired())
            case .connecting, .syncing, .ready, .loginRequired:
                return []
            }

        case .enteredBackground:
            guard state.hasSession else { return [] }
            return apply(state.session.stop())

        // MARK: Login
        case .loginSubmitted(let text):
            guard state.status != .loggingIn else { return [] }
            let address: ServerAddress
            do {
                address = try ServerAddress(text)
            } catch ServerAddressError.insecure {
                state.loginMessage = "http は localhost などのループバックだけで使えます。https の URL を入れてください"
                return []
            } catch {
                state.loginMessage = "https://ホスト名[:ポート] の形で入れてください"
                return []
            }
            state.loginMessage = nil
            state.status = .loggingIn
            guard address.origin.absoluteString != state.serverOrigin else { return [.startLogin] }
            state.serverOrigin = address.origin.absoluteString
            state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
            return [.saveServerAddress(address), .startLogin]

        // MARK: The main screen
        case .reconnectRequested:
            return resume()

        case .balloonCloseTapped:
            // The × reads everything up to her last reply, as on the Mac (ADR 0022).
            guard let last = UIProps.shownReply(state.conversation, readingHistory: false) else { return [] }
            return apply(state.session.readReplies(through: last.messageId))

        case .inputSubmitted(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return apply(state.session.send(text: text))

        case .outgoingDismissed(let requestId):
            state.session.dismiss(requestId: requestId)
            return []
        }
    }

    /// Drops the connection and asks whether there is still a session to come back with.
    private mutating func resume() -> [PhoneEffect] {
        _ = state.session.stop()
        guard state.serverOrigin != nil else {
            state.status = .needsServer
            return [.disconnect]
        }
        return [.disconnect, .resumeSession]
    }

    /// Passes the session machine's effects on as the mediator's own, and reads the connection's state off it.
    private mutating func apply(_ effects: [SessionEffect]) -> [PhoneEffect] {
        var out: [PhoneEffect] = []
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
}

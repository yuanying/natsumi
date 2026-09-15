import AppKit
import NatsumiCore
import Observation

/// The app's state and the glue between the session machine, the WebSocket, login and storage.
@MainActor
@Observable
final class AppModel {
    enum Status: Equatable {
        case needsServer
        case needsLogin
        case loggingIn
        case connecting
        case connected
        case reconnecting
        case unavailable(String)
        case replaced
        case stopped
    }

    private(set) var status: Status = .needsServer
    private(set) var conversation = ConversationState() {
        didSet { balloon.update(with: conversation) }
    }
    private(set) var balloon = BalloonState()
    private(set) var avatar: AvatarArt = .placeholder
    private(set) var hasSession = false
    private(set) var lastError: String?
    /// Which of the input field and the history are open around the character.
    var visibility = OverlayVisibility()
    var characterScale = CharacterScale.default {
        didSet { overlaySettings.characterScale = characterScale }
    }

    @ObservationIgnored let account = AccountStore(secrets: KeychainSecretStore(), defaults: .standard)
    @ObservationIgnored private let overlaySettings = OverlaySettings(defaults: .standard)
    @ObservationIgnored private var machine = SessionMachine(deviceId: nil)
    @ObservationIgnored private var socket: WebSocketClient?
    @ObservationIgnored private var socketID: UUID?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private let loginFlow = GitHubLoginFlow()

    private static let avatarDirectoryKey = "avatarDirectory"

    var expression: NatsumiCore.Expression { conversation.expression }
    var serverOrigin: String { account.serverAddress?.origin.absoluteString ?? "" }

    func launch() {
        characterScale = overlaySettings.characterScale
        reloadAvatar()
        resume()
    }

    // MARK: - Server and login

    func saveServer(_ text: String) throws {
        let address = try ServerAddress(text)
        guard address != account.serverAddress else { return }
        disconnect()
        account.serverAddress = address
        conversation = ConversationState()
        resume()
    }

    /// Connects when a server is set and a live session is in the Keychain.
    func resume() {
        disconnect()
        guard account.serverAddress != nil else {
            status = .needsServer
            return
        }
        hasSession = account.session() != nil
        guard hasSession else {
            status = .needsLogin
            return
        }
        machine = SessionMachine(deviceId: account.deviceId)
        apply(machine.start())
    }

    func login() async {
        guard let server = account.serverAddress else {
            status = .needsServer
            return
        }
        status = .loggingIn
        do {
            let grant = try await loginFlow.run(server: server)
            try account.saveSession(grant)
            lastError = nil
            resume()
        } catch LoginError.cancelled {
            status = .needsLogin
        } catch {
            lastError = Self.describe(error)
            status = .needsLogin
        }
    }

    func logout() async {
        let token = account.session()?.token
        let server = account.serverAddress
        disconnect()
        account.clearSession()
        hasSession = false
        conversation = ConversationState()
        status = account.serverAddress == nil ? .needsServer : .needsLogin
        if let token, let server {
            _ = try? await URLSession.shared.data(for: AuthAPI.logoutRequest(server: server, token: token))
        }
    }

    // MARK: - Conversation

    func send(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        apply(machine.send(text: text))
    }

    func dismiss(requestId: String) {
        machine.dismiss(requestId: requestId)
        conversation = machine.conversation
    }

    func dismissBalloon() {
        balloon.dismiss()
    }

    // MARK: - Avatar

    var avatarDirectoryPath: String {
        get { UserDefaults.standard.string(forKey: Self.avatarDirectoryKey) ?? Self.defaultAvatarDirectory.path }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed == Self.defaultAvatarDirectory.path {
                UserDefaults.standard.removeObject(forKey: Self.avatarDirectoryKey)
            } else {
                UserDefaults.standard.set(trimmed, forKey: Self.avatarDirectoryKey)
            }
            reloadAvatar()
        }
    }

    static var defaultAvatarDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("natsumi/avatar", isDirectory: true)
    }

    /// The owner's own avatar directory wins over the bundled one; the placeholder is the last resort.
    func reloadAvatar() {
        let external = URL(fileURLWithPath: (avatarDirectoryPath as NSString).expandingTildeInPath, isDirectory: true)
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Avatars/natsumi", isDirectory: true)
        avatar = AvatarLoader.resolve(candidates: [external] + (bundled.map { [$0] } ?? []))
    }

    var avatarDescription: String {
        switch avatar {
        case .sprite(let asset) where asset.directory.path.hasPrefix(Bundle.main.bundlePath): "同梱のアバターを使っています"
        case .sprite(let asset): "\(asset.directory.path) のアバターを使っています"
        case .placeholder: "アバターを読み込めないため、仮の絵を使っています"
        }
    }

    // MARK: - Connection

    private func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        _ = machine.stop()
        closeSocket()
    }

    private func closeSocket() {
        socket?.close()
        socket = nil
        socketID = nil
    }

    private func apply(_ effects: [SessionEffect]) {
        for effect in effects {
            switch effect {
            case .connect:
                connect()
            case .disconnect:
                closeSocket()
            case .send(let envelope):
                if let data = try? envelope.encoded(), let text = String(data: data, encoding: .utf8) { socket?.send(text) }
            case .saveDeviceId(let id):
                account.deviceId = id
            case .requireLogin:
                closeSocket()
                account.clearSession()
                hasSession = false
            case .scheduleReconnect(let delay):
                closeSocket()
                reconnectTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled, let self else { return }
                    self.apply(self.machine.reconnectTimerFired())
                }
            }
        }
        refresh()
    }

    private func connect() {
        closeSocket()
        guard let server = account.serverAddress, let grant = account.session() else {
            _ = machine.stop()
            hasSession = false
            status = .needsLogin
            return
        }
        let id = UUID()
        socketID = id
        socket = WebSocketClient(request: AuthAPI.webSocketRequest(server: server, token: grant.token)) { [weak self] event in
            // Events of a socket that was already replaced are dropped.
            guard let self, self.socketID == id else { return }
            self.handle(event)
        }
    }

    private func handle(_ event: WebSocketClient.Event) {
        switch event {
        case .opened:
            apply(machine.connected())
        case .message(let data):
            apply(machine.received(data))
        case .closed(let reason):
            socket = nil
            socketID = nil
            apply(machine.closed(reason))
        }
    }

    private func refresh() {
        conversation = machine.conversation
        switch machine.phase {
        case .idle: break
        case .connecting, .syncing: status = .connecting
        case .ready: status = .connected
        case .waitingToReconnect: status = .reconnecting
        case .unavailable(let code): status = .unavailable(code)
        case .loginRequired: status = .needsLogin
        case .replaced: status = .replaced
        case .stopped: status = .stopped
        }
    }

    // MARK: - Text

    var statusText: String {
        switch status {
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

    static func describe(_ error: Error) -> String {
        switch error {
        case LoginError.server(let code): "ログインできませんでした（\(code)）"
        case LoginError.http(let status, let code): "ログインできませんでした（HTTP \(status)\(code.map { "、\($0)" } ?? "")）"
        case LoginError.stateMismatch: "ログインの応答が一致しませんでした。やり直してください"
        case is LoginError: "ログインできませんでした"
        default: "ログインできませんでした（\(error.localizedDescription)）"
        }
    }
}

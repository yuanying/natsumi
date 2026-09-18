import AppKit
import NatsumiCore
import SwiftUI

/// The root of the tree, and the only thing outside it may hold.
///
/// It owns the mediator, runs the effects the mediator asks for, and lays the panels out. Events from the owner
/// arrive from the components below; events from the world outside (the socket, the login, the Keychain, the
/// avatar) are raised here. Both go into the same mediator, and what comes back is drawn and done.
@MainActor
final class RootComponent: Component {
    private var mediator = UIMediator()
    private let menuBar: MenuBarModel
    private let account = AccountStore(secrets: KeychainSecretStore(), defaults: .standard)
    private let overlaySettings = OverlaySettings(defaults: .standard)
    private let loginFlow = GitHubLoginFlow()

    private var character: CharacterComponent!
    private let balloon = BalloonComponent()
    private let notices = NoticeBundleComponent()
    private let input = InputComponent()
    private let history = HistoryComponent()
    private let settings = SettingsComponent()
    private let windows = PanelDelegate()

    private var socket: WebSocketClient?
    private var socketID: UUID?
    private var reconnectTask: Task<Void, Never>?
    private var outsideClickMonitor: Any?

    /// The pointer: where it is watched around, the monitor that reports it moving, and the wait before she goes or
    /// comes back. The mediator hears only "the pointer settled by her" and "it has gone".
    private var pointerAnchor: CGRect?
    private var pointerMonitor: Any?
    private var pointerIsNear = false
    private var lastPointerSample = Date.distantPast
    private var pointerTask: Task<Void, Never>?

    private var pending: [UIEvent] = []
    private var draining = false
    private var placement = ColumnPlacement()
    private var appliedProps: RootProps?
    private var wasHistoryOpen = false
    /// A run the mediator asked for is under way: the panels ride along with her, so nothing is laid out again.
    private var isRunningCharacter = false
    /// Which run is the current one. A run that was stopped part way must not report itself finished.
    private var runToken = 0
    /// The width the layout last asked each card's panel for. Its height comes from the drawing; its width is at
    /// least this, so that the drawing is never cut off at the sides while it is still re-setting itself.
    private var cardWidths: [ObjectIdentifier: CGFloat] = [:]

    private static let avatarDirectoryKey = "avatarDirectory"
    private static let characterFrameName = "natsumi.character"

    init(menuBar: MenuBarModel) {
        self.menuBar = menuBar
        super.init(name: "root")
        character = CharacterComponent(
            menu: { [weak self] in self?.contextMenu() },
            pointerMoved: { [weak self] in self?.pointerMoved() })
        for child in [character as Component, balloon, notices, input, history, settings] { adopt(child) }

        balloon.onSize = { [weak self] size in
            guard let self else { return }
            self.cardResized(self.balloon.panel, to: size)
        }
        notices.onSize = { [weak self] size in
            guard let self else { return }
            self.cardResized(self.notices.panel, to: size)
        }
        menuBar.send = sink
        character.panel.delegate = windows
        history.panel.delegate = windows
        settings.panel.delegate = windows
        windows.didMove = { [weak self] window in
            guard let self, window === self.character.panel else { return }
            self.deliver(.characterFrameChanged(self.character.panel.frame, visible: self.visibleFrame))
            if !self.isRunningCharacter { self.refresh(placeHistory: true) }
        }
        windows.willClose = { [weak self] window in
            guard let self else { return }
            if window === self.history.panel { self.history.dispatch(.historyCloseRequested) }
            if window === self.settings.panel { self.settings.dispatch(.settingsCloseRequested) }
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.character.dispatch(.screenConfigurationChanged(visible: self.visibleFrame))
            }
        }
    }

    /// Everything the tree is touched from outside with.
    override func handle(_ event: UIEvent) -> Bool {
        deliver(event)
        return true
    }

    func launch() {
        if !character.panel.setFrameUsingName(Self.characterFrameName), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            character.panel.setFrameOrigin(NSPoint(x: visible.maxX - 160, y: visible.minY + 40))
        }
        // The frame is saved when she comes to rest in a place of her own, not on every move: standing out of the
        // pointer's way would otherwise become the place she starts in next time.
        character.panel.orderFrontRegardless()
        deliver(.launched(LaunchInfo(
            characterScale: overlaySettings.characterScale, inputBoxSize: overlaySettings.inputBoxSize,
            serverOrigin: account.serverAddress?.origin.absoluteString, avatarDirectory: avatarDirectory,
            defaultAvatarDirectory: Self.defaultAvatarDirectory.path)))
        deliver(.characterFrameChanged(character.panel.frame, visible: visibleFrame))
    }

    // MARK: - One event at a time

    /// Events are settled one by one. An effect may raise another event, so they queue up rather than nest; the
    /// panels are drawn once at the end, and only then do the effects that need a panel on the screen run.
    private func deliver(_ event: UIEvent) {
        pending.append(event)
        guard !draining else { return }
        draining = true
        var afterDrawing: [UIEffect] = []
        while !pending.isEmpty {
            for effect in mediator.handle(pending.removeFirst()) {
                switch effect {
                case .focusInput, .makeHistoryKey, .showSettings: afterDrawing.append(effect)
                default: perform(effect)
                }
            }
        }
        draining = false
        refresh()
        for effect in afterDrawing { perform(effect) }
    }

    // MARK: - Drawing and layout

    /// Derives the drawing parameters, lays the column out with the most of the stacks that fits, and hands every
    /// component its own parameters.
    ///
    /// Drawing and placing are two jobs. While she is running, only the drawing is done: the panels are her child
    /// windows and travel with her, so laying the column out again would fight the animation — but she is running,
    /// and that is a drawing parameter that has to reach her view or the running art is never shown.
    private func refresh(placeHistory: Bool = false) {
        guard !isRunningCharacter else { return render(UIProps.root(mediator.state, placement: placement)) }
        let state = mediator.state
        fitCharacter(state)
        placement.width = state.inputBoxSize.width
        var props = UIProps.root(state, placement: placement)
        let inputSize = props.input.map { fittingSize(of: input.probe($0), width: $0.boxSize.width) }
        let historyOpening = props.history != nil && !wasHistoryOpen

        let layout = OverlayLayout.fit(
            visible: visibleFrame, character: character.panel.frame,
            spacing: OverlayLayout.spacing(for: state.characterScale), input: inputSize,
            history: props.history != nil && (placeHistory || historyOpening) ? history.panel.frame.size : nil,
            steps: UIProps.budgetSteps(state)
        ) { budget in
            placement.budget = budget
            let stacked = UIProps.root(state, placement: placement)
            // Each panel is measured at its own width: an opened card is wider than the rest of the column.
            return (
                notices: stacked.notices.map { fittingSize(of: notices.probe($0), width: $0.width) },
                balloon: stacked.balloon.map { fittingSize(of: balloon.probe($0), width: $0.width) })
        }
        placement.budget = layout.budget
        placement.tail = layout.tail
        placement.tailX = layout.tailX
        props = UIProps.root(state, placement: placement)

        render(props)
        place(balloon.panel, at: layout.balloon, sizedByDrawing: true)
        place(notices.panel, at: layout.notices, sizedByDrawing: true)
        place(input.panel, at: layout.input)
        placeHistoryWindow(props.history != nil, frame: layout.history)
        wasHistoryOpen = props.history != nil
    }

    /// A card's drawing has reached a new size on its way to the one it is animating towards. The panel takes that
    /// size, and the column is put back together around it (ADR 0016).
    ///
    /// The width is held at the widest of what the drawing wants and what the layout asked for: while a card is
    /// narrowing, the drawing is the wide one for a moment, and a panel narrower than its drawing would cut the
    /// words off at the sides.
    private func cardResized(_ panel: NSPanel, to size: CGSize) {
        guard panel.isVisible, !isRunningCharacter, size != .zero else { return }
        let width = max(size.width, cardWidths[ObjectIdentifier(panel)] ?? size.width)
        let wanted = CGSize(width: width, height: size.height)
        if panel.frame.size != wanted {
            panel.setFrame(CGRect(origin: panel.frame.origin, size: wanted), display: true)
        }
        placeColumn()
    }

    /// Puts the column back together from the sizes the panels have right now, rather than the ones the layout
    /// measured. A card part way through growing or shrinking has neither of those yet.
    private func placeColumn() {
        let state = mediator.state
        func size(_ panel: NSPanel) -> CGSize? { panel.isVisible ? panel.frame.size : nil }
        let layout = OverlayLayout.make(
            visible: visibleFrame, character: character.panel.frame,
            spacing: OverlayLayout.spacing(for: state.characterScale),
            notices: size(notices.panel), balloon: size(balloon.panel), input: size(input.panel), history: nil)
        for (panel, rect) in [
            (balloon.panel, layout.balloon), (notices.panel, layout.notices), (input.panel, layout.input),
        ] {
            guard let rect, panel.isVisible, panel.frame.origin != rect.origin else { continue }
            panel.setFrameOrigin(rect.origin)
        }
    }

    /// Hands every component its own drawing parameters, when they are not the ones it already has.
    private func render(_ props: RootProps) {
        guard props != appliedProps else { return }
        appliedProps = props
        character.render(props.character)
        balloon.render(props.balloon)
        notices.render(props.notices)
        input.render(props.input)
        history.render(props.history)
        settings.render(props.settings)
        menuBar.props = props.menu
    }


    private var visibleFrame: CGRect {
        let panel = character.panel
        let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? panel.screen ?? NSScreen.main
        return screen?.visibleFrame ?? panel.frame
    }

    /// Sizes the character to the scale. Only a new size moves her (keeping her feet in place); showing or hiding
    /// panels never does.
    private func fitCharacter(_ state: UIState) {
        let panel = character.panel
        let frame = OverlayLayout.characterFrame(panel.frame, art: state.characterScale.artSize, visible: visibleFrame)
        guard frame != panel.frame else { return }
        panel.setFrame(frame, display: true)
        if !state.isSteppedAside { panel.saveFrame(usingName: Self.characterFrameName) }
    }

    /// Runs her to a place the mediator chose. The panels in the column are her child windows, so they go with her;
    /// the history is not, and is put back where it belongs once she arrives.
    private func runCharacter(to origin: CGPoint) {
        let panel = character.panel
        var frame = panel.frame
        frame.origin = origin
        guard frame != panel.frame else {
            deliver(.characterMoveFinished)
            return
        }
        isRunningCharacter = true
        runToken += 1
        let token = runToken
        NSAnimationContext.runAnimationGroup({ context in
            // The time comes from how far she has to go, so the running art plays at the same footfall either way.
            context.duration = CharacterRun.duration(from: panel.frame.origin, to: origin)
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(frame, display: true)
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.runToken == token else { return }
                self.isRunningCharacter = false
                self.deliver(.characterMoveFinished)
                self.refresh(placeHistory: true)
            }
        })
    }

    /// Stops a run part way and leaves her exactly where it got to. Re-aiming the animator with no duration
    /// replaces the animation in flight; without that, it would keep moving her under the owner's hand.
    private func stopRunningCharacter() {
        guard isRunningCharacter else { return }
        isRunningCharacter = false
        runToken += 1
        let panel = character.panel
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            panel.animator().setFrame(panel.frame, display: true)
        }
    }

    /// `sizedByDrawing`: the panel's size is the drawing's own, so only where it stands is settled here. Its size
    /// arrives from `cardResized` as the drawing animates.
    private func place(_ panel: NSPanel, at frame: CGRect?, sizedByDrawing: Bool = false) {
        guard let frame else {
            if panel.parent != nil { character.panel.removeChildWindow(panel) }
            panel.orderOut(nil)
            cardWidths.removeValue(forKey: ObjectIdentifier(panel))
            return
        }
        if sizedByDrawing {
            cardWidths[ObjectIdentifier(panel)] = frame.width
            // Showing it for the first time takes the measured frame whole, so it never appears at nothing.
            if !panel.isVisible || panel.frame.size == .zero {
                panel.setFrame(frame, display: true)
            } else if panel.frame.origin != frame.origin {
                panel.setFrameOrigin(frame.origin)
            }
        } else if panel.frame != frame {
            panel.setFrame(frame, display: true)
        }
        if panel.parent == nil { character.panel.addChildWindow(panel, ordered: .above) }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    /// The history is not in the column and not a child window: a titled window kept on the screen by AppKit would
    /// otherwise pull the character along with it.
    private func placeHistoryWindow(_ isOpen: Bool, frame: CGRect?) {
        let panel = history.panel
        guard isOpen else {
            if panel.isVisible { panel.orderOut(nil) }
            return
        }
        if let frame, panel.frame != frame { panel.setFrame(frame, display: true) }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    private func fittingSize<V: View>(of view: V, width: CGFloat) -> CGSize {
        let size = NSHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 10_000))
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    /// The menu on a right click (or control-click) on the character. It belongs to her, so its events are raised
    /// there.
    private func contextMenu() -> NSMenu {
        let props = menuBar.props
        let menu = NSMenu()
        menu.addItem(item("話しかける", .talkRequested))
        menu.addItem(item("履歴を開く", .historyOpenRequested))
        menu.addItem(.separator())
        let readAll = item("返事をすべて既読にする", .readAllRepliesRequested)
        readAll.isEnabled = props.canReadAllReplies
        menu.addItem(readAll)
        let checkAll = item("知らせをすべて確認する", .acknowledgeAllNoticesRequested)
        checkAll.isEnabled = props.canAcknowledgeAllNotices
        menu.addItem(checkAll)
        menu.addItem(.separator())
        if props.showsLogin { menu.addItem(item("GitHub でログイン", .loginRequested)) }
        menu.addItem(item("設定…", .settingsOpenRequested))
        let logout = item("ログアウト", .logoutRequested)
        logout.isEnabled = props.canLogout
        menu.addItem(logout)
        menu.addItem(.separator())
        menu.addItem(item("終了", .quitRequested))
        menu.autoenablesItems = false
        return menu
    }

    private func item(_ title: String, _ event: UIEvent) -> ActionMenuItem {
        ActionMenuItem(title) { [weak self] in self?.character.dispatch(event) }
    }

    // MARK: - Doing what the mediator asked for

    private func perform(_ effect: UIEffect) {
        switch effect {
        case .connect:
            connect()
        case .disconnect:
            reconnectTask?.cancel()
            reconnectTask = nil
            closeSocket()
        case .sendToServer(let envelope):
            if let data = try? envelope.encoded(), let text = String(data: data, encoding: .utf8) { socket?.send(text) }
        case .saveDeviceId(let id):
            account.deviceId = id
        case .clearSession:
            account.clearSession()
        case .scheduleReconnect(let delay):
            reconnectTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                self?.deliver(.reconnectTimerFired)
            }
        case .resumeSession:
            deliver(.sessionResumed(hasSession: account.session() != nil, deviceId: account.deviceId))
        case .startLogin:
            startLogin()
        case .logout:
            logout()
        case .saveServerAddress(let address):
            account.serverAddress = address
        case .saveCharacterScale(let scale):
            overlaySettings.characterScale = scale
        case .saveInputBoxSize(let size):
            overlaySettings.inputBoxSize = size
        case .saveAvatarDirectory(let path):
            if let path {
                UserDefaults.standard.set(path, forKey: Self.avatarDirectoryKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.avatarDirectoryKey)
            }
        case .loadAvatar(let directory):
            loadAvatar(directory)
        case .focusInput:
            input.focus()
        case .watchOutsideClicks(let watching):
            watchOutsideClicks(watching)
        case .moveCharacter(let origin):
            runCharacter(to: origin)
        case .stopCharacterMove:
            stopRunningCharacter()
        case .saveCharacterPlace:
            character.panel.saveFrame(usingName: Self.characterFrameName)
        case .watchPointer(let anchor):
            watchPointer(anchor)
        case .makeHistoryKey:
            history.panel.makeKey()
        case .showSettings:
            showSettings()
        case .hideSettings:
            settings.panel.orderOut(nil)
        case .terminate:
            NSApp.terminate(nil)
        }
    }

    private func closeSocket() {
        socket?.close()
        socket = nil
        socketID = nil
    }

    private func connect() {
        closeSocket()
        guard let server = account.serverAddress, let grant = account.session() else {
            deliver(.credentialsMissing)
            return
        }
        let id = UUID()
        socketID = id
        socket = WebSocketClient(request: AuthAPI.webSocketRequest(server: server, token: grant.token)) { [weak self] event in
            // Events of a socket that was already replaced are dropped.
            guard let self, self.socketID == id else { return }
            switch event {
            case .opened:
                self.deliver(.socketOpened)
            case .message(let data):
                self.deliver(.socketReceived(data))
            case .closed(let reason):
                self.socket = nil
                self.socketID = nil
                self.deliver(.socketClosed(reason))
            }
        }
    }

    private func startLogin() {
        guard let server = account.serverAddress else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let grant = try await self.loginFlow.run(server: server)
                try self.account.saveSession(grant)
                self.deliver(.loginFinished(.succeeded))
            } catch LoginError.cancelled {
                self.deliver(.loginFinished(.cancelled))
            } catch {
                self.deliver(.loginFinished(.failed(Self.describe(error))))
            }
        }
    }

    private func logout() {
        let token = account.session()?.token
        let server = account.serverAddress
        account.clearSession()
        guard let token, let server else { return }
        Task {
            _ = try? await URLSession.shared.data(for: AuthAPI.logoutRequest(server: server, token: token))
        }
    }

    /// A click in another app closes the input field.
    private func watchOutsideClicks(_ watching: Bool) {
        if watching, outsideClickMonitor == nil {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.input.dispatch(.clickedOutsideApp) }
            }
        } else if !watching, let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }

    // MARK: - The pointer

    /// Watches the pointer around a rectangle: usually where the character stands, and, while she is standing out of
    /// its way, the place she will come back to. Mouse moves are thinned out here and never reach the mediator; it
    /// hears only that the pointer settled by her or that it has gone.
    private func watchPointer(_ anchor: CGRect?) {
        pointerAnchor = anchor
        pointerTask?.cancel()
        pointerTask = nil
        pointerIsNear = false
        if anchor != nil, pointerMonitor == nil {
            // A global monitor sees the pointer everywhere but inside this app's own windows; the character's panel
            // has a tracking area for that part.
            pointerMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
                MainActor.assumeIsolated { self?.pointerMoved() }
            }
        } else if anchor == nil, let monitor = pointerMonitor {
            NSEvent.removeMonitor(monitor)
            pointerMonitor = nil
        }
    }

    private func pointerMoved() {
        guard let anchor = pointerAnchor else { return }
        let now = Date()
        guard now.timeIntervalSince(lastPointerSample) >= PointerDodge.sampleInterval else { return }
        lastPointerSample = now
        let pointer = NSEvent.mouseLocation
        let scale = mediator.state.characterScale.textScale
        // The panels in the column are there to be clicked: a pointer on one of them is not on its way past her.
        let onAPanel = [balloon.panel, notices.panel, input.panel].contains { $0.isVisible && $0.frame.contains(pointer) }
        if !pointerIsNear, !onAPanel, PointerDodge.isNear(pointer, of: anchor, textScale: scale) {
            pointerIsNear = true
            waitThen(PointerDodge.linger) { [weak self] in
                guard let self, let anchor = self.pointerAnchor else { return }
                let now = NSEvent.mouseLocation
                guard PointerDodge.isNear(now, of: anchor, textScale: scale) else { return }
                self.deliver(.pointerCameNear(at: now))
            }
        } else if pointerIsNear, PointerDodge.isAway(pointer, of: anchor, textScale: scale) {
            pointerIsNear = false
            waitThen(PointerDodge.settle) { [weak self] in
                guard let self, let anchor = self.pointerAnchor,
                      PointerDodge.isAway(NSEvent.mouseLocation, of: anchor, textScale: scale)
                else { return }
                self.deliver(.pointerWentAway)
            }
        }
    }

    /// The one wait the pointer has going at a time: a new one replaces the one before, so a pointer that passes by
    /// never sets her off.
    private func waitThen(_ delay: TimeInterval, _ body: @escaping @MainActor () -> Void) {
        pointerTask?.cancel()
        pointerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, self != nil else { return }
            body()
        }
    }

    /// The settings open in the same layer, centered on the character's screen.
    private func showSettings() {
        let visible = visibleFrame
        let size = settings.panel.frame.size
        settings.panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        settings.panel.makeKeyAndOrderFront(nil)
    }

    // MARK: - The avatar and the settings on this Mac

    private var avatarDirectory: String {
        UserDefaults.standard.string(forKey: Self.avatarDirectoryKey) ?? Self.defaultAvatarDirectory.path
    }

    static var defaultAvatarDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("natsumi/avatar", isDirectory: true)
    }

    /// The owner's own avatar directory wins over the bundled one; the placeholder is the last resort.
    private func loadAvatar(_ directory: String) {
        let external = URL(fileURLWithPath: (directory as NSString).expandingTildeInPath, isDirectory: true)
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Avatars/natsumi", isDirectory: true)
        let art = AvatarLoader.resolve(candidates: [external] + (bundled.map { [$0] } ?? []))
        let description = switch art {
        case .sprite(let asset) where asset.directory.path.hasPrefix(Bundle.main.bundlePath):
            "同梱のアバターを使っています"
        case .sprite(let asset):
            "\(asset.directory.path) のアバターを使っています"
        case .placeholder:
            "アバターを読み込めないため、仮の絵を使っています"
        }
        deliver(.avatarLoaded(art, description: description))
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

/// The window callbacks the root needs. `Component` is not an `NSObject`, so the panels report here.
@MainActor
final class PanelDelegate: NSObject, NSWindowDelegate {
    var didMove: (NSWindow) -> Void = { _ in }
    var willClose: (NSWindow) -> Void = { _ in }

    func windowDidMove(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        didMove(window)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        willClose(sender)
        return false
    }
}

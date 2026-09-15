import AppKit
import NatsumiCore
import SwiftUI

/// A panel in the character's layer: above other windows and full-screen apps, on every Space, without activating the app.
final class OverlayPanel: NSPanel {
    /// The input field and the history take keyboard focus; the character and the balloon never do.
    var acceptsKey = false
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { acceptsKey }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    static func make(style: NSWindow.StyleMask = [.borderless], acceptsKey: Bool = false) -> OverlayPanel {
        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: style.union(.nonactivatingPanel),
            backing: .buffered, defer: false)
        panel.acceptsKey = acceptsKey
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // `.borderless` is the empty mask, so `contains(.borderless)` is always true; test for a title bar instead.
        // A titled panel made clear and then opaque again draws none of its content.
        if !style.contains(.titled) {
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            // The comic panels are paper-white with black ink in both appearances.
            panel.appearance = NSAppearance(named: .aqua)
        }
        return panel
    }
}

/// The character and the column around it: the notices and the balloon above, the input field below (flipped near
/// the top of the screen), and the history beside the column. The column's panels are child windows of the
/// character's panel, so they move with it while it is dragged. The character only moves when the owner drags it.
@MainActor
final class OverlayController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private let character = OverlayPanel.make()
    private let balloon = OverlayPanel.make()
    private let notices = OverlayPanel.make()
    private let input = OverlayPanel.make(acceptsKey: true)
    private let history = OverlayPanel.make(style: [.titled, .closable, .resizable], acceptsKey: true)
    private let settings = OverlayPanel.make(style: [.titled, .closable], acceptsKey: true)
    private let placement = ColumnPlacement()
    private var outsideClickMonitor: Any?
    private var wasInputOpen = false
    private var wasHistoryOpen = false

    private static let historySize = NSSize(width: 340, height: 440)

    init(model: AppModel) {
        self.model = model
        super.init()

        character.delegate = self
        character.contentView = ClickOrDragHostingView(
            rootView: CharacterView(model: model),
            onClick: { [weak self] point in
                guard let self else { return }
                if self.model.notices.badgeCount > 0, CharacterBadge.frame(for: self.model.characterScale).contains(point) {
                    self.model.toggleNotices()
                } else {
                    self.update { $0.characterClicked() }
                }
            },
            menu: { [weak self] in self?.contextMenu() })
        balloon.contentView = FirstMouseHostingView(rootView: BalloonView(model: model, placement: placement, openHistory: openHistory))
        notices.contentView = FirstMouseHostingView(rootView: NoticeBundleView(model: model, placement: placement, openHistory: openHistory))
        input.contentView = FirstMouseHostingView(rootView: InputView(model: model, openHistory: openHistory) { [weak self] in
            self?.update { $0.escape() }
        })
        input.onCancel = { [weak self] in self?.update { $0.escape() } }
        history.title = "natsumi の履歴"
        history.delegate = self
        history.setContentSize(Self.historySize)
        history.contentView = NSHostingView(rootView: HistoryView(model: model))
        history.onCancel = { [weak self] in self?.update { $0.closeHistory() } }
        // Opaque, so the history reads well over any window in both appearances.
        history.isOpaque = true
        history.backgroundColor = .windowBackgroundColor

        let settingsView = NSHostingView(rootView: SettingsView(model: model))
        settings.title = "natsumi の設定"
        settings.delegate = self
        settings.isOpaque = true
        settings.backgroundColor = .windowBackgroundColor
        settings.contentView = settingsView
        settings.setContentSize(settingsView.fittingSize)
        settings.onCancel = { [weak settings] in settings?.orderOut(nil) }
        model.openSettings = { [weak self] in self?.showSettings() }

        if !character.setFrameUsingName("natsumi.character"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            character.setFrameOrigin(NSPoint(x: visible.maxX - 160, y: visible.minY + 40))
        }
        character.setFrameAutosaveName("natsumi.character")
        fitCharacter()
        character.orderFrontRegardless()

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepCharacterOnScreen() }
        }
        observe()
    }

    func openInput() { update { $0.openInput() } }
    func openHistory() { update { $0.openHistory() } }

    /// The settings open in the same layer, centered on the character's screen.
    func showSettings() {
        let visible = visibleFrame
        let size = settings.frame.size
        settings.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        settings.makeKeyAndOrderFront(nil)
    }

    /// The menu on a right click (or control-click) on the character.
    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(ActionMenuItem("話しかける") { [weak self] in self?.openInput() })
        menu.addItem(ActionMenuItem("履歴を開く") { [weak self] in self?.openHistory() })
        menu.addItem(.separator())
        if model.status == .needsLogin {
            menu.addItem(ActionMenuItem("GitHub でログイン") { [model] in Task { await model.login() } })
        }
        menu.addItem(ActionMenuItem("設定…") { [weak self] in self?.showSettings() })
        let logout = ActionMenuItem("ログアウト") { [model] in Task { await model.logout() } }
        logout.isEnabled = model.hasSession
        menu.addItem(logout)
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("終了") { NSApp.terminate(nil) })
        menu.autoenablesItems = false
        return menu
    }

    private func update(_ change: (inout OverlayVisibility) -> Void) {
        change(&model.visibility)
    }

    /// Lays the panels out again whenever what they show changes.
    private func observe() {
        withObservationTracking {
            _ = (model.characterScale, model.balloon, model.notices, model.visibility, model.status, model.conversation.outbox,
                 model.avatar, model.inputBoxSize, model.inputTextHeight)
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.fitCharacter()
                self.observe()
            }
        }
    }

    // MARK: - Layout

    private var visibleFrame: CGRect {
        let center = NSPoint(x: character.frame.midX, y: character.frame.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? character.screen ?? NSScreen.main
        return screen?.visibleFrame ?? character.frame
    }

    /// Sizes the character to the scale. Only a new size moves it (keeping its feet in place); showing or hiding
    /// panels never does.
    private func fitCharacter() {
        let frame = OverlayLayout.characterFrame(character.frame, art: model.characterScale.artSize, visible: visibleFrame)
        if frame != character.frame { character.setFrame(frame, display: true) }
        layout(placeHistory: false)
    }

    /// The screens changed (a display went away, the resolution changed): bring the character back onto one.
    private func keepCharacterOnScreen() {
        let frame = OverlayLayout.clamp(character.frame, into: visibleFrame)
        if frame != character.frame { character.setFrame(frame, display: true) }
        fitCharacter()
    }

    private func layout(placeHistory: Bool) {
        let visibility = model.visibility
        placement.width = model.inputBoxSize.width
        let inputSize = visibility.isInputOpen
            ? fittingSize(of: InputView(model: model, openHistory: {}, close: {}), width: placement.width) : nil
        let historyOpening = visibility.isHistoryOpen && !wasHistoryOpen
        let showBalloon = model.balloon.content != nil
        let showNotices = model.notices.isShown

        let layout = OverlayLayout.fit(
            visible: visibleFrame, character: character.frame, spacing: OverlayLayout.spacing(for: model.characterScale),
            input: inputSize, history: visibility.isHistoryOpen && (placeHistory || historyOpening) ? history.frame.size : nil
        ) { budget in
            placement.budget = budget
            return (
                notices: showNotices ? fittingSize(of: NoticeBundleView(model: model, placement: placement, openHistory: {}), width: placement.width) : nil,
                balloon: showBalloon ? fittingSize(of: BalloonView(model: model, placement: placement, openHistory: {}), width: placement.width) : nil)
        }

        placement.budget = layout.budget
        placement.tail = layout.tail
        placement.tailX = layout.tailX
        place(balloon, at: layout.balloon)
        place(notices, at: layout.notices)

        place(input, at: layout.input)
        if visibility.isInputOpen && !wasInputOpen {
            input.makeKey()
            if let field = input.contentView?.descendant(withIdentifier: InputTextView.identifier) {
                input.makeFirstResponder(field)
            }
        }
        wasInputOpen = visibility.isInputOpen
        watchOutsideClicks(visibility.isInputOpen)

        // The history is not in the column and not a child window: a titled window kept on the screen by AppKit
        // would otherwise pull the character along with it.
        if visibility.isHistoryOpen {
            if let frame = layout.history, history.frame != frame { history.setFrame(frame, display: true) }
            if !history.isVisible { history.orderFront(nil) }
            if historyOpening { history.makeKey() }
        } else if history.isVisible {
            history.orderOut(nil)
        }
        wasHistoryOpen = visibility.isHistoryOpen
    }

    private func place(_ panel: NSPanel, at frame: CGRect?) {
        guard let frame else {
            if panel.parent != nil { character.removeChildWindow(panel) }
            panel.orderOut(nil)
            return
        }
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        if panel.parent == nil { character.addChildWindow(panel, ordered: .above) }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    private func fittingSize<V: View>(of view: V, width: CGFloat) -> CGSize {
        let size = NSHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 10_000))
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    /// A click in another app closes the input field.
    private func watchOutsideClicks(_ watching: Bool) {
        if watching, outsideClickMonitor == nil {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.update { $0.clickedOutside() } }
            }
        } else if !watching, let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }

    // MARK: - NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        guard (notification.object as? NSWindow) === character else { return }
        layout(placeHistory: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === history { update { $0.closeHistory() } }
        if sender === settings { settings.orderOut(nil) }
        return false
    }
}

extension NSView {
    func descendant(withIdentifier identifier: NSUserInterfaceItemIdentifier) -> NSView? {
        if self.identifier == identifier { return self }
        for subview in subviews {
            if let found = subview.descendant(withIdentifier: identifier) { return found }
        }
        return nil
    }
}

/// Buttons in a panel of an inactive app work on the first click. The panel's frame comes only from the layout: the
/// hosting view must not resize its window to the view's ideal size, which moves the panel off its place.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    required init(rootView: Content) {
        super.init(rootView: rootView)
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A menu item that runs a closure.
final class ActionMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("not used")
    }

    @objc private func run() {
        // Menus call their actions on the main thread.
        let handler = handler
        MainActor.assumeIsolated { handler() }
    }
}

/// A click reports where it landed (origin at the top left); a drag moves the window; a right click or control-click
/// shows the menu.
final class ClickOrDragHostingView<Content: View>: NSHostingView<Content> {
    private var onClick: @MainActor (CGPoint) -> Void = { _ in }
    private var menuProvider: @MainActor () -> NSMenu? = { nil }
    private var dragged = false

    init(rootView: Content, onClick: @escaping @MainActor (CGPoint) -> Void, menu: @escaping @MainActor () -> NSMenu?) {
        self.onClick = onClick
        self.menuProvider = menu
        super.init(rootView: rootView)
        // The character's frame is set only by its scale and the owner's drag.
        sizingOptions = []
    }

    override func rightMouseDown(with event: NSEvent) {
        showMenu(with: event)
    }

    private func showMenu(with event: NSEvent) {
        guard let menu = menuProvider() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    required init(rootView: Content) {
        super.init(rootView: rootView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        dragged = false
        if event.modifierFlags.contains(.control) {
            // Handled as a right click; the mouse-up that follows must not also open the input field.
            dragged = true
            showMenu(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragged else { return }
        dragged = true
        window?.performDrag(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        guard !dragged else { return }
        let point = convert(event.locationInWindow, from: nil)
        onClick(CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y))
    }
}

struct CharacterView: View {
    let model: AppModel

    var body: some View {
        let scale = model.characterScale
        TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
            art(elapsed: context.date.timeIntervalSinceReferenceDate, scale: scale)
        }
        .frame(width: scale.artSize.width, height: scale.artSize.height)
        .overlay(alignment: .bottomTrailing) {
            if model.status != .connected {
                Circle().fill(.gray).frame(width: 10, height: 10).padding(4).help(model.statusText)
            }
        }
        .overlay(alignment: .topLeading) {
            let count = model.notices.badgeCount
            if count > 0 {
                let badge = CharacterBadge.frame(for: scale)
                let ink = max(1.5, badge.height / 10)
                ZStack {
                    Circle().fill(Comic.badge)
                    Circle().stroke(Comic.ink, lineWidth: ink)
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(Comic.font(badge.height * (count > 9 ? 0.45 : 0.6), bold: true))
                        .foregroundStyle(Comic.ink)
                        .minimumScaleFactor(0.5)
                }
                .frame(width: badge.width - ink, height: badge.height - ink)
                .offset(x: badge.minX + ink / 2, y: badge.minY + ink / 2)
                .help(model.notices.isShown ? "未確認の知らせ \(count) 件（クリックで隠す）" : "未確認の知らせ \(count) 件（クリックで出す）")
            }
        }
    }

    @ViewBuilder
    private func art(elapsed: TimeInterval, scale: CharacterScale) -> some View {
        switch model.avatar {
        case .sprite(let asset):
            // Frames are 2x pixels; they are resampled smoothly to the chosen size.
            Image(decorative: asset.frame(for: model.expression, elapsed: elapsed), scale: 2)
                .resizable()
                .interpolation(.high)
                .antialiased(true)
                .frame(width: scale.artSize.width, height: scale.artSize.height)
        case .placeholder:
            Text(PlaceholderArt.symbol(for: model.expression))
                .font(.system(size: 64 * scale.value))
        }
    }
}

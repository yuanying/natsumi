import Carbon.HIToolbox
import NatsumiCore

/// The global shortcut, registered with the system (ADR 0023). Carbon's hot keys are delivered to this app whichever
/// app is in front and need no Accessibility permission, which a global event monitor would.
@MainActor
final class GlobalHotKey {
    var onPress: @MainActor () -> Void = {}
    private var registered: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x6E74_736D  // "ntsm"

    init() {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(), { _, _, context in
                // Hot keys arrive on the main thread, through the app's event loop.
                guard let context else { return OSStatus(eventNotHandledErr) }
                let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(context).takeUnretainedValue()
                MainActor.assumeIsolated { hotKey.onPress() }
                return noErr
            }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    /// Registers the key in place of the one before, or none. False when the system would not take it.
    func register(_ key: HotKey?) -> Bool {
        if let registered { UnregisterEventHotKey(registered) }
        registered = nil
        guard let key else { return true }
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(key.keyCode), Self.carbonModifiers(key.modifiers),
            EventHotKeyID(signature: Self.signature, id: 1), GetApplicationEventTarget(), 0, &ref)
        guard status == noErr else { return false }
        registered = ref
        return true
    }

    private static func carbonModifiers(_ modifiers: HotKey.Modifiers) -> UInt32 {
        var carbon = 0
        if modifiers.contains(.command) { carbon |= cmdKey }
        if modifiers.contains(.shift) { carbon |= shiftKey }
        if modifiers.contains(.option) { carbon |= optionKey }
        if modifiers.contains(.control) { carbon |= controlKey }
        return UInt32(carbon)
    }
}

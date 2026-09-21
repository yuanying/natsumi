import Foundation

/// The key combination that brings the conversation window out from anywhere (ADR 0023). It is kept as the
/// hardware key code and the modifiers, which is what the system registers; the name is only for showing.
public struct HotKey: Equatable, Sendable {
    public struct Modifiers: OptionSet, Equatable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        public static let control = Modifiers(rawValue: 1 << 0)
        public static let option = Modifiers(rawValue: 1 << 1)
        public static let shift = Modifiers(rawValue: 1 << 2)
        public static let command = Modifiers(rawValue: 1 << 3)
    }

    /// The virtual key codes of the keys named here (`kVK_*` in Carbon's `Events.h`).
    public enum KeyCode {
        public static let n: UInt16 = 45
        public static let escape: UInt16 = 53
    }

    public var keyCode: UInt16
    public var modifiers: Modifiers

    public init(keyCode: UInt16, modifiers: Modifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// ⌃⌥N. ⌘⇧N was asked for first, but it is New Folder in Finder, a private window in the browsers and New
    /// Project in Xcode, and a global shortcut takes the key away from all of them.
    public static let `default` = HotKey(keyCode: KeyCode.n, modifiers: [.control, .option])

    /// A key that stands for itself everywhere would be lost to every app, so it needs ⌘, ⌃ or ⌥ — except the
    /// function keys, which no one types. A modifier key on its own is not a key.
    public var isUsable: Bool {
        guard !Self.modifierKeyCodes.contains(keyCode) else { return false }
        return Self.functionKeys[keyCode] != nil || !modifiers.isDisjoint(with: [.command, .control, .option])
    }

    /// The way the menus write it: ⌃⌥⇧⌘, then the key.
    public var displayName: String {
        var name = ""
        if modifiers.contains(.control) { name += "⌃" }
        if modifiers.contains(.option) { name += "⌥" }
        if modifiers.contains(.shift) { name += "⇧" }
        if modifiers.contains(.command) { name += "⌘" }
        return name + (Self.keyNames[keyCode] ?? Self.functionKeys[keyCode] ?? "Key\(keyCode)")
    }

    private static let modifierKeyCodes: Set<UInt16> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]

    /// The keys by where they are on an ANSI keyboard. A JIS keyboard has the letters and digits in the same places.
    private static let keyNames: [UInt16: String] = [
        0: "A", 11: "B", 8: "C", 2: "D", 14: "E", 3: "F", 5: "G", 4: "H", 34: "I", 38: "J", 40: "K", 37: "L",
        46: "M", 45: "N", 31: "O", 35: "P", 12: "Q", 15: "R", 1: "S", 17: "T", 32: "U", 9: "V", 13: "W", 7: "X",
        16: "Y", 6: "Z",
        29: "0", 18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
        27: "-", 24: "=", 33: "[", 30: "]", 42: "\\", 41: ";", 39: "'", 43: ",", 47: ".", 44: "/", 50: "`",
        93: "¥", 94: "_", 102: "英数", 104: "かな",
        49: "Space", 36: "↩", 48: "⇥", 51: "⌫", 117: "⌦", 53: "⎋",
        123: "←", 124: "→", 125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
    ]

    private static let functionKeys: [UInt16: String] = [
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9",
        109: "F10", 103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15", 106: "F16", 64: "F17",
        79: "F18", 80: "F19", 90: "F20",
    ]
}

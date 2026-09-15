/// Which of the input field and the history are open.
public struct OverlayVisibility: Equatable, Sendable {
    public private(set) var isInputOpen = false
    public private(set) var isHistoryOpen = false

    public init() {}

    public mutating func characterClicked() { isInputOpen.toggle() }
    public mutating func openInput() { isInputOpen = true }
    public mutating func escape() { isInputOpen = false }
    /// A click in another app. The history stays open so it can be read while working.
    public mutating func clickedOutside() { isInputOpen = false }

    public mutating func openHistory() { isHistoryOpen = true }
    public mutating func closeHistory() { isHistoryOpen = false }
    public mutating func toggleHistory() { isHistoryOpen.toggle() }
}

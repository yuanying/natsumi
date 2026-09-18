import Foundation

/// Where an event is thrown in. A component hands one out so that a view can raise an event without knowing who
/// will answer it, or that anyone will.
public struct EventSink: Sendable {
    private let action: @MainActor @Sendable (UIEvent) -> Void

    public init(_ action: @escaping @MainActor @Sendable (UIEvent) -> Void) {
        self.action = action
    }

    @MainActor
    public func callAsFunction(_ event: UIEvent) {
        action(event)
    }

    /// Drops everything. Used while a panel is measured, where no one is meant to act on what is drawn.
    public static let ignored = EventSink { _ in }
}

/// A node of the one tree the whole UI lives in.
///
/// A component draws with the parameters it is given and raises events; it decides nothing. An event travels from
/// the component it happened in towards the root, and every component on the way may answer it. The root answers
/// everything, so the chain always ends there.
@MainActor
open class Component {
    public let name: String
    public private(set) weak var parent: Component?
    public private(set) var children: [Component] = []

    public init(name: String) {
        self.name = name
    }

    /// Puts a component under this one. A component belongs to one parent for its whole life.
    public func adopt(_ child: Component) {
        precondition(child.parent == nil, "\(child.name) already has a parent")
        child.parent = self
        children.append(child)
    }

    /// Raises an event here. It goes up until a component answers it.
    public final func dispatch(_ event: UIEvent) {
        guard !handle(event) else { return }
        parent?.dispatch(event)
    }

    /// Answers an event, or lets it pass. Swallowing is only for what a component settles with its own drawing
    /// parameters; the default is to let everything through to the mediator at the root.
    open func handle(_ event: UIEvent) -> Bool { false }

    /// The port this component's views raise events through.
    public var sink: EventSink {
        EventSink { [weak self] event in self?.dispatch(event) }
    }
}

import Foundation

/// Follows the device stream: an event applies only when it is the next one on the stream the last snapshot or
/// resume established. Anything else is a duplicate to ignore or a gap that needs a new sync.
public struct StreamTracker: Equatable, Sendable {
    public enum Verdict: Equatable, Sendable {
        case apply
        case ignore
        case resync
    }

    public private(set) var position: StreamPosition?

    public init(position: StreamPosition? = nil) {
        self.position = position
    }

    public mutating func reset() {
        position = nil
    }

    public mutating func accept(_ envelope: ServerEnvelope) -> Verdict {
        let at = envelope.position
        // A snapshot is the barrier: events numbered after it apply on top.
        if case .snapshot = envelope.event {
            position = at
            return .apply
        }
        // The line she is writing takes no number of its own: it carries the one the stream is already at
        // (ADR 0017). So it is applied where it is, never moves the position, and never reads as a gap. Before the
        // stream is established there is nothing to draw it in, so it is dropped rather than resynced for.
        if case .thinking = envelope.event {
            guard let current = position, current.epoch == at.epoch, current.streamId == at.streamId else { return .ignore }
            return .apply
        }
        if let current = position, current.epoch == at.epoch, current.streamId == at.streamId {
            if at.seq <= current.seq { return .ignore }
            if at.seq != current.seq + 1 { return .resync }
            // Unknown types still take a number on the stream.
            position = at
            return envelope.event == nil ? .ignore : .apply
        }
        switch envelope.event {
        case .unavailable(_, .some):
            // The answer to a sync: it arrives on the device stream.
            position = at
            return .apply
        case .accepted, .rejected, .unavailable:
            // Answers before a sync come from the connection's temporary stream and do not move the position.
            return .apply
        case nil:
            return .ignore
        default:
            return .resync
        }
    }
}

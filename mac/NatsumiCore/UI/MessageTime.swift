import Foundation

/// When a line in the history was said, as short as the day allows: the time alone for today, the month and day
/// with it for this year, and the year as well before that. Root gives the real now and calendar; tests give fixed
/// ones.
public struct MessageTime: Equatable, Sendable {
    public var now: Date
    public var calendar: Calendar

    public init(now: Date, calendar: Calendar) {
        self.now = now
        self.calendar = calendar
    }

    /// The labels of the history's dates, in time order; nil where the server's timestamp could not be read. The
    /// history is derived again at every event that may change it, so the calendar is asked once a day, not once a
    /// row: within a day, the time is how far the date is from its start.
    public func labels(_ dates: [Date?]) -> [String?] {
        let today = calendar.dateInterval(of: .day, for: now)
        let thisYear = calendar.dateInterval(of: .year, for: now)
        var day: (interval: DateInterval, prefix: String)?
        return dates.map { date in
            guard let date else { return nil }
            if day.map({ !(($0.interval.start ..< $0.interval.end).contains(date)) }) ?? true {
                guard let interval = calendar.dateInterval(of: .day, for: date) else { return nil }
                let at = calendar.dateComponents([.year, .month, .day], from: date)
                let prefix = if today?.start == interval.start {
                    ""
                } else if thisYear.map({ ($0.start ..< $0.end).contains(date) }) ?? false {
                    "\(at.month!)/\(at.day!) "
                } else {
                    "\(at.year!)/\(at.month!)/\(at.day!) "
                }
                day = (interval, prefix)
            }
            return day!.prefix + clock(date, in: day!.interval)
        }
    }

    private func clock(_ date: Date, in day: DateInterval) -> String {
        let hour: Int, minute: Int
        if day.duration == 24 * 60 * 60 {
            let seconds = Int(date.timeIntervalSince(day.start))
            (hour, minute) = (seconds / 3600, seconds % 3600 / 60)
        } else {
            // A day the clocks change on is not 24 hours long, and its clock is not the time since it began.
            let at = calendar.dateComponents([.hour, .minute], from: date)
            (hour, minute) = (at.hour!, at.minute!)
        }
        return "\(hour):" + (minute < 10 ? "0\(minute)" : "\(minute)")
    }
}

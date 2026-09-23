import Foundation
import RectoCoreJS

/// The one JS core for the process.
///
/// `RectoCore` costs ~tens of milliseconds to evaluate, so a second instance
/// is a second load and a second JS heap for a document the process already
/// holds. Every feature that needs the authority — the export HTML pipeline,
/// `parseOutline` — awaits the same load here; the first ask pays it off the
/// main thread, and later ones share the engine.
enum SharedRectoCore {
    /// The one load, started on first use. Deliberately kept (rather than
    /// retried) when it fails: a bundle that is missing at the first ask is
    /// still missing at the second, and re-paying the load on every call would
    /// turn a broken build into a slow one.
    private static let load: Task<RectoCore, any Error> = Task.detached(priority: .userInitiated) {
        try RectoCore()
    }

    static func core() async throws -> RectoCore {
        try await load.value
    }
}
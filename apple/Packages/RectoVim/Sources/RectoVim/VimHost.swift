import Foundation
import JavaScriptCore

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// What JS may ask Swift for, mid-keystroke.
///
/// `JSExport` bridges each of these into the context as a plain JS function.
/// Everything crosses as a `String` because reading a field off a `JSValue` is
/// a bridge crossing of its own — one JSON string beats five property reads.
///
/// These are all *rare* calls. Geometry is reached only by scrolling and
/// visual-line commands, history only by `u`/`<C-r>`, the clipboard only by the
/// `"+`/`"*` registers. The editing commands never leave JS.
@objc public protocol VimHostExport: JSExport {
    func geometry(_ requestJSON: String) -> String?
    func historyCommand(_ kind: String) -> String?
    func clipboardRead() -> String
    func clipboardWrite(_ text: String)
}

/// Layout questions only the text view can answer.
public struct VimGeometryRequest: Decodable {
    public let kind: String
    public let offset: Int?
    public let mode: String?
    public let amount: Int?
    public let unit: String?
    public let goalColumn: Double?
    public let coords: Coords?

    public struct Coords: Decodable {
        public let left: Double
        public let top: Double
    }
}

/// Implemented by whatever owns the text view.
///
/// Main-actor isolated: JS only reaches these from inside a `handleKey` call,
/// which runs on the thread that owns the `JSContext` — the main one.
@MainActor
public protocol VimGeometryProvider: AnyObject {
    func lineHeight() -> Double
    func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double)
    func offsetAtCoords(left: Double, top: Double) -> Int
    func scrollInfo() -> (top: Double, height: Double, clientHeight: Double)
    /// Vertical motion that respects soft wrapping. Return nil to let JS fall
    /// back to document lines.
    func verticalMove(from offset: Int, amount: Int, unit: String, goalColumn: Double?)
        -> (offset: Int, hitSide: Bool)?
}

/// Implemented by whatever owns undo. In the product this is the document's
/// undo tree; in the adapters it is the text view's undo manager.
///
/// **The caret is vim's, and it comes from the patch.** Vim puts the cursor at
/// the start of the change it just restored. `NSUndoManager` restores whatever
/// selection it recorded, which in the spike's proof was two lines away, and
/// comparing the two full strings cannot recover the location when the
/// surrounding text repeats — on `"aa"`, `ia<Esc>u` leaves a caret at offset 1
/// where the patch started at 0. So an implementation must carry the range it
/// actually applied.
@MainActor
public protocol VimHistoryProvider: AnyObject {
    /// Perform the undo or redo and describe what it did, or nil when there was
    /// nothing to do.
    func performHistory(_ kind: String) -> VimHistoryResult?
}

/// The buffer after an undo or redo, and where vim should put the caret.
public struct VimHistoryResult: Sendable, Equatable {
    public let text: String
    /// UTF-16 offset of the start of the restored change.
    public let patchStart: Int

    public init(text: String, patchStart: Int) {
        self.text = text
        self.patchStart = patchStart
    }
}

/// Records what an undo transaction changed, so its start can be reported
/// rather than inferred.
///
/// `NSUndoManager` and `UIUndoManager` both tell us *when* an undo happened and
/// neither tells us *what* it touched, so the adapters register the range
/// alongside the edit and read it back here. Shared between AppKit and UIKit
/// because the contract is the same and a second copy would drift.
@MainActor
public final class VimUndoPatchLog {
    private var undoStack: [NSRange] = []
    private var redoStack: [NSRange] = []

    public init() {}

    /// The union of the ranges one keystroke wrote, in post-edit coordinates.
    public func record(_ ranges: [NSRange]) {
        guard let union = ranges.reduce(nil, Self.union) else { return }
        undoStack.append(union)
        redoStack.removeAll()
    }

    /// Pops the range an undo (or redo) is about to restore.
    public func take(_ kind: String) -> NSRange? {
        if kind == "undo" {
            guard let range = undoStack.popLast() else { return nil }
            redoStack.append(range)
            return range
        }
        guard let range = redoStack.popLast() else { return nil }
        undoStack.append(range)
        return range
    }

    public func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
    }

    private static func union(_ lhs: NSRange?, _ rhs: NSRange) -> NSRange {
        guard let lhs else { return rhs }
        let lower = min(lhs.location, rhs.location)
        let upper = max(NSMaxRange(lhs), NSMaxRange(rhs))
        return NSRange(location: lower, length: upper - lower)
    }
}

/// The object handed to `RectoVim.init()` as the JS-side `host`.
///
/// Everything here is a *pull*: JS asks a question mid-keystroke and blocks on
/// the answer. That is only affordable because these calls are rare — geometry
/// is reached by scrolling and visual-line commands, history by `u`/`<C-r>`, the
/// clipboard by the `"+`/`"*` registers. The editing commands never leave JS.
///
/// The exported methods are `nonisolated` because `JSExport` cannot express
/// actor isolation, but every one of them is in fact reached synchronously from
/// a `handleKey` call on the main thread. `assumeIsolated` states that
/// invariant where the compiler can check it at runtime, rather than papering
/// over it with `@preconcurrency`.
public final class VimHost: NSObject, VimHostExport, @unchecked Sendable {
    public override init() { super.init() }

    @MainActor public weak var geometryProvider: VimGeometryProvider?
    @MainActor public weak var historyProvider: VimHistoryProvider?

    /// Swapped out in the headless suite so it stays off the real pasteboard.
    ///
    /// Only the `"+` and `"*` registers reach these; vim's own registers never
    /// touch the system pasteboard, which is why a yank does not clobber what
    /// the user copied from another app.
    @MainActor public var pasteboardRead: () -> String = {
        #if canImport(AppKit)
        NSPasteboard.general.string(forType: .string) ?? ""
        #elseif canImport(UIKit)
        UIPasteboard.general.string ?? ""
        #else
        ""
        #endif
    }

    @MainActor public var pasteboardWrite: (String) -> Void = { text in
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    public nonisolated func geometry(_ requestJSON: String) -> String? {
        MainActor.assumeIsolated {
            guard let provider = geometryProvider,
                  let data = requestJSON.data(using: .utf8),
                  let request = try? JSONDecoder().decode(VimGeometryRequest.self, from: data)
            else { return nil }

            switch request.kind {
            case "lineHeight":
                return Self.encode(["lineHeight": provider.lineHeight()])
            case "charCoords":
                let coords = provider.charCoords(offset: request.offset ?? 0)
                return Self.encode([
                    "left": coords.left, "top": coords.top, "bottom": coords.bottom,
                ])
            case "coordsChar":
                guard let c = request.coords else { return nil }
                let offset = provider.offsetAtCoords(left: c.left, top: c.top)
                return Self.encode(["offset": Double(offset)])
            case "scrollInfo":
                let info = provider.scrollInfo()
                return Self.encode([
                    "left": 0, "top": info.top, "height": info.height, "width": 0,
                    "clientHeight": info.clientHeight, "clientWidth": 0,
                ])
            case "findPosV":
                guard let moved = provider.verticalMove(
                    from: request.offset ?? 0,
                    amount: request.amount ?? 0,
                    unit: request.unit ?? "line",
                    goalColumn: request.goalColumn
                ) else { return nil }
                return Self.encode([
                    "offset": Double(moved.offset), "hitSide": moved.hitSide ? 1 : 0,
                ])
            default:
                return nil
            }
        }
    }

    public nonisolated func historyCommand(_ kind: String) -> String? {
        MainActor.assumeIsolated {
            guard let result = historyProvider?.performHistory(kind) else { return nil }
            // JSONEncoder on a bare String gives a correctly escaped JS literal,
            // which matters because the buffer can contain quotes and newlines.
            let text = String(
                data: (try? JSONEncoder().encode(result.text)) ?? Data(),
                encoding: .utf8
            ) ?? "\"\""
            // A caret, not a selection: vim leaves the cursor at the start of
            // the restored change.
            let caret = result.patchStart
            return "{\"text\":\(text),\"anchor\":\(caret),\"head\":\(caret)}"
        }
    }

    public nonisolated func clipboardRead() -> String {
        MainActor.assumeIsolated { pasteboardRead() }
    }

    public nonisolated func clipboardWrite(_ text: String) {
        MainActor.assumeIsolated { pasteboardWrite(text) }
    }

    private static func encode(_ dict: [String: Double]) -> String {
        let body = dict.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",")
        return "{\(body)}"
    }
}

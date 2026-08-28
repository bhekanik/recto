import Foundation
import JavaScriptCore

#if canImport(AppKit)
import AppKit
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
@objc public protocol RectoVimHostExport: JSExport {
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
/// undo tree; in the spike it is `NSTextView`'s undo manager.
@MainActor
public protocol VimHistoryProvider: AnyObject {
    /// Perform the undo/redo and return the resulting buffer and caret, or nil
    /// if there was nothing to do.
    func performHistory(_ kind: String) -> (text: String, anchor: Int, head: Int)?
}

/// The object handed to `RectoVim.init()` as the JS-side `host`.
///
/// The exported methods are `nonisolated` because `JSExport` cannot express
/// actor isolation, but every one of them is in fact reached synchronously from
/// a `handleKey` call on the main thread. `assumeIsolated` states that
/// invariant where the compiler can check it at runtime, rather than papering
/// over it with `@preconcurrency`.
public final class RectoVimHost: NSObject, RectoVimHostExport, @unchecked Sendable {
    @MainActor public weak var geometryProvider: VimGeometryProvider?
    @MainActor public weak var historyProvider: VimHistoryProvider?

    /// Swapped out in the headless suite so it stays off the real pasteboard.
    @MainActor public var pasteboardRead: () -> String = {
        #if canImport(AppKit)
        NSPasteboard.general.string(forType: .string) ?? ""
        #else
        ""
        #endif
    }

    @MainActor public var pasteboardWrite: (String) -> Void = { text in
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
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
            return "{\"text\":\(text),\"anchor\":\(result.anchor),\"head\":\(result.head)}"
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

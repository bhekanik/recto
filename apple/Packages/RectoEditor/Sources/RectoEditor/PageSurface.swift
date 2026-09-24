//
//  PageSurface.swift
//  RectoEditor
//

import AppKit
import SwiftUI

/// What sits behind a document: the canvas with the web's atmosphere (two
/// soft glows and a film grain, `body::before/after` in `app/globals.css`),
/// or, flat, the sheet colour edge to edge.
public struct DocumentBackdrop: View {
    private let theme: RectoEditorTheme
    private let showsSheet: Bool

    public init(theme: RectoEditorTheme, showsSheet: Bool) {
        self.theme = theme
        self.showsSheet = showsSheet
    }

    public var body: some View {
        if showsSheet {
            ZStack {
                Color(nsColor: theme.canvas)
                Canvas { context, size in
                    // radial-gradient(125% 85% at 18% -8%, atmos-1, transparent 55%)
                    Self.glow(theme.atmosphere1, at: CGPoint(x: 0.18, y: -0.08), stop: 0.55, in: size, context: context)
                    // radial-gradient(125% 85% at 92% 112%, atmos-2, transparent 58%)
                    Self.glow(theme.atmosphere2, at: CGPoint(x: 0.92, y: 1.12), stop: 0.58, in: size, context: context)
                }
                Image(nsImage: FilmGrain.tile)
                    .resizable(resizingMode: .tile)
                    .opacity(theme.isLight ? 0.035 : 0.025)
                    .blendMode(theme.isLight ? .multiply : .softLight)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        } else {
            Color(nsColor: theme.sheet)
        }
    }

    /// CSS's elliptical radial gradient: radii 125% × 85% of the box, fading to
    /// transparent at `stop` of those radii. Drawn in a space scaled so the
    /// ellipse is a unit circle, which is what makes it elliptical.
    private static func glow(
        _ color: NSColor, at center: CGPoint, stop: CGFloat, in size: CGSize, context: GraphicsContext
    ) {
        var context = context
        context.translateBy(x: center.x * size.width, y: center.y * size.height)
        context.scaleBy(x: 1.25 * size.width, y: 0.85 * size.height)
        let gradient = Gradient(stops: [
            .init(color: Color(nsColor: color), location: 0),
            .init(color: Color(nsColor: color.withAlphaComponent(0)), location: stop),
        ])
        context.fill(
            Path(CGRect(x: -2, y: -2, width: 4, height: 4)),
            with: .radialGradient(gradient, center: .zero, startRadius: 0, endRadius: 1))
    }
}

/// The sheet: the writing column lifted off the canvas, the design's
/// signature element (plan 023 design §2). Full height, rounded at the top,
/// with a top-light hairline and a soft lift.
struct WritingSheet: View {
    let theme: RectoEditorTheme
    let width: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let sheetWidth = min(width, proxy.size.width)
            let shape = UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10, style: .continuous)
            shape
                .fill(Color(nsColor: theme.sheet))
                .overlay(alignment: .top) {
                    shape.stroke(
                        LinearGradient(
                            colors: [Color.white.opacity(theme.isLight ? 0.9 : 0.07), .clear],
                            startPoint: .top, endPoint: .init(x: 0.5, y: 0.08)),
                        lineWidth: 1)
                }
                .shadow(color: .black.opacity(theme.isLight ? 0.08 : 0.35), radius: 28, y: 8)
                .frame(width: sheetWidth)
                .padding(.top, 10)
                .frame(maxWidth: .infinity)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension RectoEditorTheme {
    /// Paper and any light palette: ink darker than the sheet.
    public var isLight: Bool {
        (sheet.usingColorSpace(.sRGB)?.brightnessComponent ?? 0)
            > (ink.usingColorSpace(.sRGB)?.brightnessComponent ?? 1)
    }
}

/// A 128 pt tile of monochrome noise, made once: the web's feTurbulence
/// grain as a bitmap, so no filter runs per frame.
enum FilmGrain {
    static let tile: NSImage = {
        let side = 128
        var generator = SplitMix(seed: 0x5EC7)
        var pixels = [UInt8](repeating: 0, count: side * side)
        for index in pixels.indices { pixels[index] = UInt8(truncatingIfNeeded: generator.next()) }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let image = CGImage(
            width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        return NSImage(cgImage: image, size: NSSize(width: side, height: side))
    }()

    /// Seeded so the grain is the same on every launch and in every snapshot.
    private struct SplitMix {
        var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }
}

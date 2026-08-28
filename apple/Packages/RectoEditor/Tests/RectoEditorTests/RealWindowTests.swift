//
//  RealWindowTests.swift
//  RectoEditorTests
//
//  Every test that puts a window on screen lives under this suite.
//
//  `NSApplication`, the window list and the AppKit run loop are process-global.
//  Two suites mounting windows concurrently crashed the runner with SIGSEGV —
//  reproducibly, before this existed. Swift Testing parallelises across suites
//  by default, so `.serialized` on each one individually was not enough: they
//  have to be nested inside one serialized parent to be ordered against each
//  other.
//

import Testing

@Suite("Real window", .serialized)
struct RealWindowTests {}

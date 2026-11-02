// swift-tools-version:6.0
import PackageDescription

// Mux in the menu bar: the agent and the machines, one click from the top of the screen. ./build.sh makes Mux.app.
let package = Package(
  name: "MuxBar",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "MuxBar", path: "Sources/MuxBar")],
  swiftLanguageModes: [.v5]
)

import AppKit
import CoreAudio
import CoreGraphics

/// What only an app in the person's session can see, for this Mac's presence: a fullscreen app, and the microphone in
/// use (a call). Neither needs a permission: the input device's running state, and the bounds of on-screen windows.
enum MacSignals {
  static func micInUse() -> Bool {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr, device != 0 else { return false }
    var running = UInt32(0)
    size = UInt32(MemoryLayout<UInt32>.size)
    addr.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
  }

  /// The frontmost app has a window exactly the size of a screen (a fullscreen video, game or presentation).
  @MainActor static func fullscreen() -> Bool {
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier != "com.apple.finder" else { return false }
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    let screens = NSScreen.screens.map(\.frame.size)
    for w in windows where (w[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
      guard let b = w[kCGWindowBounds as String] as? [String: CGFloat], let width = b["Width"], let height = b["Height"] else { continue }
      if screens.contains(where: { abs($0.width - width) < 1 && abs($0.height - height) < 1 }) { return true }
    }
    return false
  }
}

import AppKit
import Carbon.HIToolbox

/// ⌥⌘L from anywhere: open or fold the wall at the notch (the window where
/// there is no notch). Carbon's RegisterEventHotKey needs no accessibility
/// permission and never sees other keystrokes.
final class Hotkey {
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: () -> Void

  /// Taken by another app: the menu still works, and the log says so.
  private(set) var registered = false

  init(keyCode: UInt32 = UInt32(kVK_ANSI_L), modifiers: UInt32 = UInt32(cmdKey | optionKey), action: @escaping () -> Void) {
    self.action = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, user in
      guard let user else { return noErr }
      let hk = Unmanaged<Hotkey>.fromOpaque(user).takeUnretainedValue()
      DispatchQueue.main.async { hk.action() }
      return noErr
    }, 1, &spec, me, &handler)
    guard status == noErr else { NSLog("leanlamp: hotkey handler failed (\(status))"); return }
    let id = EventHotKeyID(signature: OSType(0x6C6C_6D70), id: 1) // 'llmp'
    let r = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    registered = r == noErr
    if !registered { NSLog("leanlamp: ⌥⌘L is taken by another app (\(r)) — use the menu") }
  }

  deinit {
    if let ref { UnregisterEventHotKey(ref) }
    if let handler { RemoveEventHandler(handler) }
  }
}

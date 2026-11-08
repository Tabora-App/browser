import CoreGraphics
import Foundation
let name = CommandLine.arguments.count > 1 ? CommandLine.arguments[1].lowercased() : "tabora"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for w in list {
  guard let owner = w["kCGWindowOwnerName"] as? String, owner.lowercased() == name,
        let b = w["kCGWindowBounds"] as? [String: Any], (b["Height"] as? Double ?? 0) > 300 else { continue }
  print(w["kCGWindowNumber"] as! Int)
  break
}

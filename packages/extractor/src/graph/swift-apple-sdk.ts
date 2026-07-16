// The Apple / system-framework + Swift-stdlib module DROP-LIST — the substrate an
// `import` names but the diagram deliberately does NOT render as an external
// dependency node (the analogue of ELIXIR_STDLIB / RUBY_STDLIB / PYTHON_STDLIB).
//
// Swift `import` is MODULE-level (`import Foundation`, `import SwiftUI`), and an
// iOS/macOS app imports dozens of Apple frameworks. Those are the PLATFORM, not
// dependencies the developer chose to pull in — rendering a box for Foundation /
// UIKit / SwiftUI on every diagram would drown the real third-party deps
// (`ext:ComposableArchitecture`, `ext:Alamofire`). So a module whose name is in
// this frozen set is dropped: no `ext:` node, no edge. A framework ADAPTER may still
// USE the fact that a file imports SwiftUI/UIKit (a role signal) — dropping the
// external node doesn't erase the import; it only keeps it off the dependency graph.
//
// The list covers: the Swift standard library + its overlays; the Darwin/Linux/
// Windows libc shims; and the Apple platform frameworks (Foundation, the UIKit/
// SwiftUI/AppKit UI stacks, the Core* family, AV/media, graphics/ML, connectivity,
// security, and the newer app-extension kits). It is deliberately GENEROUS — a
// missed Apple name renders one stray external box (harmless), while a third-party
// package almost never collides with an Apple framework name. Frozen + never eval.

/**
 * Apple SDK + Swift-stdlib module names. Membership is exact (case-sensitive — Swift
 * module names are PascalCase and stable). `isAppleSdkModule` is the public check.
 */
export const SWIFT_APPLE_SDK: ReadonlySet<string> = new Set<string>([
  // --- Swift standard library + compiler-provided overlays --------------------
  'Swift',
  '_Concurrency',
  '_StringProcessing',
  '_Differentiation',
  'RegexBuilder',
  'Distributed',
  'Synchronization',
  'Observation',
  'Builtin',
  'SwiftShims',
  'PlaygroundSupport',
  'XCTest',
  'Testing', // swift-testing (bundled with the toolchain)

  // --- libc / platform shims (cross-platform Swift) ---------------------------
  'Darwin',
  'Glibc',
  'Musl',
  'ucrt',
  'WinSDK',
  'CRT',
  'MachO',
  'ObjectiveC',
  'os', // the `os` framework (OSLog / os_log lives here)
  'OSLog',
  'Dispatch',
  'Foundation',
  'FoundationNetworking',
  'FoundationXML',
  'FoundationLegacySwift',
  'CoreFoundation',
  'CFNetwork',
  'System',

  // --- Core* framework family -------------------------------------------------
  'CoreData',
  'CoreGraphics',
  'CoreImage',
  'CoreAnimation',
  'QuartzCore',
  'CoreText',
  'CoreVideo',
  'CoreAudio',
  'CoreAudioKit',
  'CoreAudioTypes',
  'CoreMedia',
  'CoreMotion',
  'CoreLocation',
  'CoreBluetooth',
  'CoreML',
  'CoreMIDI',
  'CoreNFC',
  'CoreHaptics',
  'CoreServices',
  'CoreSpotlight',
  'CoreTelephony',
  'CoreFoundation',

  // --- UI stacks --------------------------------------------------------------
  'SwiftUI',
  'UIKit',
  'AppKit',
  'WatchKit',
  'TVUIKit',
  'TVMLKit',
  'TVServices',
  'CarPlay',
  'Cocoa',
  'DeveloperToolsSupport',
  'Symbols',

  // --- App runtime / data / concurrency helpers -------------------------------
  'Combine',
  'SwiftData',
  'TabularData',
  'Charts', // Swift Charts (Apple)
  'DataDetection',

  // --- Media / graphics / ML / reality ----------------------------------------
  'AVFoundation',
  'AVKit',
  'AVRouting',
  'AudioToolbox',
  'AudioUnit',
  'MediaPlayer',
  'MediaAccessibility',
  'MediaToolbox',
  'Photos',
  'PhotosUI',
  'Vision',
  'VisionKit',
  'ARKit',
  'RealityKit',
  'RealityFoundation',
  'SceneKit',
  'SpriteKit',
  'GameplayKit',
  'GameController',
  'GameKit',
  'ModelIO',
  'Metal',
  'MetalKit',
  'MetalPerformanceShaders',
  'MetalPerformanceShadersGraph',
  'MetalFX',
  'GLKit',
  'OpenGLES',
  'ImageIO',
  'ImageCaptureCore',
  'PDFKit',
  'PencilKit',
  'QuickLook',
  'QuickLookThumbnailing',
  'Accelerate',
  'simd',
  'CinematicKit',
  'Cinematic',

  // --- Maps / web / commerce / calendar / contacts / messaging ----------------
  'MapKit',
  'WebKit',
  'SafariServices',
  'AuthenticationServices',
  'StoreKit',
  'StoreKitTest',
  'PassKit',
  'EventKit',
  'EventKitUI',
  'Contacts',
  'ContactsUI',
  'MessageUI',
  'Messages',
  'Intents',
  'IntentsUI',
  'AppIntents',
  'UserNotifications',
  'UserNotificationsUI',
  'BackgroundTasks',
  'BackgroundAssets',
  'LinkPresentation',
  'Social',
  'MultipeerConnectivity',
  'SharedWithYou',
  'SharedWithYouCore',

  // --- Security / auth / crypto / networking ----------------------------------
  'Security',
  'SecurityFoundation',
  'SecurityInterface',
  'LocalAuthentication',
  'LocalAuthenticationEmbeddedUI',
  'CryptoKit',
  'CryptoTokenKit',
  'CommonCrypto',
  'Network',
  'NetworkExtension',
  'SystemConfiguration',
  'DeviceCheck',
  'AdSupport',
  'AppTrackingTransparency',

  // --- Health / home / sensing / language -------------------------------------
  'HealthKit',
  'HealthKitUI',
  'HomeKit',
  'WeatherKit',
  'Speech',
  'NaturalLanguage',
  'SoundAnalysis',
  'Translation',
  'SensorKit',
  'Sensitive',

  // --- App extensions / widgets / clips ---------------------------------------
  'WidgetKit',
  'ActivityKit',
  'AppClip',
  'ExtensionKit',
  'ExtensionFoundation',
  'FinderSync',
  'FileProvider',
  'FileProviderUI',
  'ClassKit',
  'ExposureNotification',
  'BusinessChat',
  'CallKit',
  'PushKit',
  'ReplayKit',
  'ScreenTime',
  'ManagedSettings',
  'ManagedSettingsUI',
  'FamilyControls',
  'DeviceActivity',
  'AccessorySetupKit',
  'MatterSupport',
  'JournalingSuggestions',
]);

/** Is `module` an Apple SDK / Swift-stdlib module the graph drops (no external node)? */
export function isAppleSdkModule(module: string): boolean {
  return SWIFT_APPLE_SDK.has(module);
}

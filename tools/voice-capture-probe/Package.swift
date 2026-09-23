// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "VoiceCaptureProbe",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "voice-capture-probe", targets: ["VoiceCaptureProbe"]),
    .executable(name: "microphone-input-probe", targets: ["MicrophoneInputProbe"]),
  ],
  targets: [
    .executableTarget(name: "VoiceCaptureProbe"),
    .executableTarget(name: "MicrophoneInputProbe"),
  ]
)

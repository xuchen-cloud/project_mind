@preconcurrency import AVFoundation
import Foundation

nonisolated private final class PeakMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var bufferCount = 0
  private var peak = Float.zero

  func observe(_ buffer: AVAudioPCMBuffer) {
    guard let channels = buffer.floatChannelData else { return }
    let channelCount = Int(buffer.format.channelCount)
    let frameCount = Int(buffer.frameLength)
    var observedPeak = Float.zero
    for channelIndex in 0..<channelCount {
      let channel = channels[channelIndex]
      for frameIndex in 0..<frameCount {
        observedPeak = max(observedPeak, abs(channel[frameIndex]))
      }
    }
    lock.withLock {
      bufferCount += 1
      peak = max(peak, observedPeak)
    }
  }

  var snapshot: (bufferCount: Int, peak: Float) {
    lock.withLock { (bufferCount, peak) }
  }
}

@main
private enum MicrophoneInputProbe {
  static func main() async {
    guard CommandLine.arguments.dropFirst().contains("--record") else {
      FileHandle.standardError.write(
        Data("error: Pass --record to start the microphone-only diagnostic.\n".utf8)
      )
      Foundation.exit(EXIT_FAILURE)
    }
    guard await requestMicrophoneAccess() else {
      FileHandle.standardError.write(Data("error: Microphone access denied.\n".utf8))
      Foundation.exit(EXIT_FAILURE)
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    let meter = PeakMeter()
    installTap(on: input, format: format, meter: meter)

    do {
      try engine.start()
      try await Task.sleep(for: .seconds(2))
      engine.stop()
      input.removeTap(onBus: 0)
      let result = meter.snapshot
      let payload: [String: Any] = [
        "bufferCount": result.bufferCount,
        "channels": format.channelCount,
        "deviceName": AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown",
        "peakAmplitude": result.peak,
        "sampleRate": format.sampleRate,
      ]
      let data = try JSONSerialization.data(
        withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data("\n".utf8))
      Foundation.exit(result.peak > 0 ? EXIT_SUCCESS : EXIT_FAILURE)
    } catch {
      FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
      Foundation.exit(EXIT_FAILURE)
    }
  }

  private static func requestMicrophoneAccess() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      true
    case .notDetermined:
      await AVCaptureDevice.requestAccess(for: .audio)
    default:
      false
    }
  }

  nonisolated private static func installTap(
    on input: AVAudioInputNode,
    format: AVAudioFormat,
    meter: PeakMeter
  ) {
    input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
      meter.observe(buffer)
    }
  }
}

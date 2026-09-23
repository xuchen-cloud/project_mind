@preconcurrency import AVFoundation
import AudioToolbox
import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

private struct Arguments {
  let duration: Duration
  let outputDirectory: URL
  let microphoneName: String?

  static func parse(_ raw: [String]) throws -> Self {
    guard raw.contains("--record") else {
      throw ProbeError.usage(
        "Capture is opt-in. Pass --record together with --output <directory>."
      )
    }

    var durationSeconds = 10.0
    var outputDirectory: URL?
    var microphoneName: String?
    var index = 0
    while index < raw.count {
      switch raw[index] {
      case "--record":
        break
      case "--duration":
        index += 1
        guard index < raw.count,
          let value = Double(raw[index]),
          value >= 1,
          value <= 300
        else {
          throw ProbeError.usage("--duration must be between 1 and 300 seconds")
        }
        durationSeconds = value
      case "--output":
        index += 1
        guard index < raw.count else {
          throw ProbeError.usage("--output requires a directory")
        }
        outputDirectory = URL(fileURLWithPath: raw[index], isDirectory: true)
      case "--microphone":
        index += 1
        guard index < raw.count else {
          throw ProbeError.usage("--microphone requires an exact device name")
        }
        microphoneName = raw[index]
      default:
        throw ProbeError.usage("Unknown argument: \(raw[index])")
      }
      index += 1
    }

    guard let outputDirectory else {
      throw ProbeError.usage("--output <directory> is required")
    }
    return Self(
      duration: .milliseconds(Int64(durationSeconds * 1_000)),
      outputDirectory: outputDirectory,
      microphoneName: microphoneName
    )
  }
}

private enum ProbeError: LocalizedError {
  case usage(String)
  case microphoneDenied
  case noMicrophone
  case microphoneNotFound(requested: String, available: [String])
  case screenRecordingDenied
  case noDisplay
  case writer(String)
  case capture(String)

  var errorDescription: String? {
    switch self {
    case .usage(let message):
      "\(message)\nUsage: voice-capture-probe --record --output <directory> [--duration <1...300>] [--microphone <name>]"
    case .microphoneDenied:
      "Microphone access was denied. Enable it in System Settings > Privacy & Security > Microphone."
    case .noMicrophone:
      "AVFoundation did not report a default microphone."
    case .microphoneNotFound(let requested, let available):
      "Microphone '\(requested)' was not found. Available devices: \(available.joined(separator: ", "))"
    case .screenRecordingDenied:
      "Screen & System Audio Recording access is required. Enable it in System Settings > Privacy & Security."
    case .noDisplay:
      "ScreenCaptureKit did not report an available display."
    case .writer(let message), .capture(let message):
      message
    }
  }
}

private struct TrackMetrics: Codable {
  let source: String
  let path: String
  let sampleBufferCount: Int
  let firstPresentationTimeSeconds: Double?
  let lastPresentationTimeSeconds: Double?
  let encodedDurationSeconds: Double?
  let fileBytes: Int64
  let rawPeakAmplitude: Double
}

private struct ProbeReport: Codable {
  let startedAt: String
  let requestedDurationSeconds: Double
  let microphoneDeviceName: String
  let systemAudio: TrackMetrics
  let microphone: TrackMetrics
  let firstBufferOffsetMilliseconds: Double?
}

private final class AudioTrackWriter: NSObject, SCStreamOutput, @unchecked Sendable {
  let queue: DispatchQueue
  private let source: String
  private let outputURL: URL
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var firstPTS: CMTime?
  private var lastPTS: CMTime?
  private var sampleBufferCount = 0
  private var rawPeakAmplitude = 0.0
  private var failure: Error?

  init(source: String, outputURL: URL) {
    self.source = source
    self.outputURL = outputURL
    self.queue = DispatchQueue(label: "app.project-mind.voice-probe.\(source)")
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard sampleBuffer.isValid,
      CMSampleBufferDataIsReady(sampleBuffer),
      failure == nil
    else { return }

    do {
      if let peak = try peakAmplitude(in: sampleBuffer) {
        rawPeakAmplitude = max(rawPeakAmplitude, peak)
      }
      if writer == nil {
        try prepareWriter(for: sampleBuffer)
      }
      guard let writer, let input else { return }
      let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      if firstPTS == nil {
        firstPTS = timestamp
        writer.startSession(atSourceTime: timestamp)
      }
      guard input.isReadyForMoreMediaData else {
        throw ProbeError.writer("\(source) writer could not keep up with real-time audio")
      }
      guard input.append(sampleBuffer) else {
        throw ProbeError.writer(
          "Failed to append \(source) audio: \(writer.error?.localizedDescription ?? "unknown error")"
        )
      }
      sampleBufferCount += 1
      lastPTS = timestamp
    } catch {
      failure = error
    }
  }

  private func prepareWriter(for sampleBuffer: CMSampleBuffer) throws {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
    else {
      throw ProbeError.writer("Missing \(source) audio format description")
    }

    let assetWriter = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: description.mSampleRate,
      AVNumberOfChannelsKey: max(1, description.mChannelsPerFrame),
      AVEncoderBitRateKey: 128_000,
    ]
    let assetInput = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: settings,
      sourceFormatHint: format
    )
    assetInput.expectsMediaDataInRealTime = true
    guard assetWriter.canAdd(assetInput) else {
      throw ProbeError.writer("Cannot configure \(source) audio writer")
    }
    assetWriter.add(assetInput)
    guard assetWriter.startWriting() else {
      throw ProbeError.writer(
        "Cannot start \(source) audio writer: \(assetWriter.error?.localizedDescription ?? "unknown error")"
      )
    }
    writer = assetWriter
    input = assetInput
  }

  func finish() async throws -> TrackMetrics {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { [self] in
        if let failure {
          continuation.resume(throwing: failure)
          return
        }
        guard let writer, let input else {
          continuation.resume(
            throwing: ProbeError.writer("No \(source) audio buffers were captured")
          )
          return
        }
        input.markAsFinished()
        writer.finishWriting { [self] in
          guard let finishedWriter = self.writer else {
            continuation.resume(
              throwing: ProbeError.writer("Lost \(source) writer before completion")
            )
            return
          }
          if finishedWriter.status != .completed {
            continuation.resume(
              throwing: ProbeError.writer(
                "Failed to finish \(source) track: \(finishedWriter.error?.localizedDescription ?? "unknown error")"
              )
            )
            return
          }
          let attributes = try? FileManager.default.attributesOfItem(atPath: outputURL.path)
          let fileBytes = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
          let duration = firstPTS.flatMap { first in
            lastPTS.map { CMTimeGetSeconds($0 - first) }
          }
          continuation.resume(
            returning: TrackMetrics(
              source: source,
              path: outputURL.path,
              sampleBufferCount: sampleBufferCount,
              firstPresentationTimeSeconds: firstPTS.map(CMTimeGetSeconds),
              lastPresentationTimeSeconds: lastPTS.map(CMTimeGetSeconds),
              encodedDurationSeconds: duration,
              fileBytes: fileBytes,
              rawPeakAmplitude: rawPeakAmplitude
            )
          )
        }
      }
    }
  }

  private func peakAmplitude(in sampleBuffer: CMSampleBuffer) throws -> Double? {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      description.mFormatID == kAudioFormatLinearPCM
    else {
      return nil
    }

    let isFloat = description.mFormatFlags & kAudioFormatFlagIsFloat != 0
    let isSignedInteger = description.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
    let bitsPerChannel = Int(description.mBitsPerChannel)

    return try sampleBuffer.withAudioBufferList { buffers, _ in
      var peak = 0.0
      for buffer in buffers {
        guard let data = buffer.mData else { continue }
        let byteCount = Int(buffer.mDataByteSize)
        let raw = UnsafeRawBufferPointer(start: data, count: byteCount)
        if isFloat && bitsPerChannel == 32 {
          for sample in raw.bindMemory(to: Float.self) where sample.isFinite {
            peak = max(peak, Double(abs(sample)))
          }
        } else if isSignedInteger && bitsPerChannel == 16 {
          for sample in raw.bindMemory(to: Int16.self) {
            peak = max(peak, Double(abs(Int32(sample))) / Double(Int16.max))
          }
        } else if isSignedInteger && bitsPerChannel == 32 {
          for sample in raw.bindMemory(to: Int32.self) {
            peak = max(peak, Double(abs(Int64(sample))) / Double(Int32.max))
          }
        } else {
          return nil
        }
      }
      return peak
    }
  }
}

private final class StreamFailureObserver: NSObject, SCStreamDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var storedError: Error?

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    lock.withLock { storedError = error }
  }

  var error: Error? { lock.withLock { storedError } }
}

private func requestMicrophoneAccess() async -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    true
  case .notDetermined:
    await AVCaptureDevice.requestAccess(for: .audio)
  default:
    false
  }
}

@main
private enum VoiceCaptureProbe {
  static func main() async {
    do {
      let arguments = try Arguments.parse(Array(CommandLine.arguments.dropFirst()))
      try await run(arguments)
    } catch {
      FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
      Foundation.exit(EXIT_FAILURE)
    }
  }

  private static func run(_ arguments: Arguments) async throws {
    guard await requestMicrophoneAccess() else { throw ProbeError.microphoneDenied }
    let microphoneDevices = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.microphone],
      mediaType: .audio,
      position: .unspecified
    ).devices
    let microphoneDevice: AVCaptureDevice?
    if let requestedName = arguments.microphoneName {
      microphoneDevice = microphoneDevices.first {
        $0.localizedName.caseInsensitiveCompare(requestedName) == .orderedSame
      }
      guard microphoneDevice != nil else {
        throw ProbeError.microphoneNotFound(
          requested: requestedName,
          available: microphoneDevices.map(\.localizedName)
        )
      }
    } else {
      microphoneDevice = AVCaptureDevice.default(for: .audio)
    }
    guard let microphoneDevice else {
      throw ProbeError.noMicrophone
    }
    guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
      throw ProbeError.screenRecordingDenied
    }

    try FileManager.default.createDirectory(
      at: arguments.outputDirectory,
      withIntermediateDirectories: true
    )
    let systemURL = arguments.outputDirectory.appendingPathComponent("system.m4a")
    let microphoneURL = arguments.outputDirectory.appendingPathComponent("microphone.m4a")
    for url in [systemURL, microphoneURL] where FileManager.default.fileExists(atPath: url.path) {
      throw ProbeError.usage("Refusing to overwrite existing file: \(url.path)")
    }

    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    guard let display = content.displays.first else { throw ProbeError.noDisplay }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.captureMicrophone = true
    configuration.microphoneCaptureDeviceID = microphoneDevice.uniqueID
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3

    let observer = StreamFailureObserver()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: observer)
    let systemWriter = AudioTrackWriter(source: "system", outputURL: systemURL)
    let microphoneWriter = AudioTrackWriter(source: "microphone", outputURL: microphoneURL)
    try stream.addStreamOutput(systemWriter, type: .audio, sampleHandlerQueue: systemWriter.queue)
    try stream.addStreamOutput(
      microphoneWriter,
      type: .microphone,
      sampleHandlerQueue: microphoneWriter.queue
    )

    let startedAt = ISO8601DateFormatter().string(from: Date())
    print("Capturing microphone and all system audio for \(arguments.duration)...")
    try await stream.startCapture()
    try await Task.sleep(for: arguments.duration)
    try await stream.stopCapture()
    if let error = observer.error {
      throw ProbeError.capture(
        "ScreenCaptureKit stopped unexpectedly: \(error.localizedDescription)")
    }

    async let systemMetrics = systemWriter.finish()
    async let microphoneMetrics = microphoneWriter.finish()
    let (system, microphone) = try await (systemMetrics, microphoneMetrics)
    let offset = system.firstPresentationTimeSeconds.flatMap { systemStart in
      microphone.firstPresentationTimeSeconds.map { microphoneStart in
        abs(systemStart - microphoneStart) * 1_000
      }
    }
    let report = ProbeReport(
      startedAt: startedAt,
      requestedDurationSeconds: arguments.duration.timeInterval,
      microphoneDeviceName: microphoneDevice.localizedName,
      systemAudio: system,
      microphone: microphone,
      firstBufferOffsetMilliseconds: offset
    )
    let reportURL = arguments.outputDirectory.appendingPathComponent("report.json")
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(report).write(to: reportURL, options: .atomic)
    print("Capture complete. Report: \(reportURL.path)")
  }
}

extension Duration {
  fileprivate var timeInterval: Double {
    let components = self.components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }
}

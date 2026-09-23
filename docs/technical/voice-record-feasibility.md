# Voice Record feasibility log

- Issue: #94
- Plan: `plans/010-voice-record-implementation.md`, VR-01
- Last verified: 2026-09-21
- Status: in progress; this document records technical evidence, not shipped product support

## macOS dual-source capture

### Verified build environment

- Host: Apple Silicon, macOS 27.0.
- Active developer directory: the system Command Line Tools selected by
  `xcode-select`.
- macOS SDK: 27.0.
- The installed ScreenCaptureKit header declares system-audio capture on macOS
  13+ and microphone output from the same `SCStream` on macOS 15+.
- `tools/voice-capture-probe` compiles in debug and release configurations with
  Swift 6.4 against that SDK.
- Invoking the executable without `--record` exits before any permission request
  or capture action.

### 10-second device run

An explicit 10-second capture was completed on 2026-09-20 while a known spoken
fixture was played through the system output:

| Source | Buffers | Reported span | Container inspection | Size |
| --- | ---: | ---: | --- | ---: |
| System audio | 528 | 10.540 s | stereo, 48 kHz AAC, 10.560 s | 110,994 bytes |
| Microphone | 938 | 9.991 s | mono, 48 kHz AAC, 10.002 s | 4,682 bytes |

Both files were accepted by the macOS audio inspector as one-track M4A files.
The system track contained the known fixture. The microphone track was silent.
Two later runs reproduced exact zero-valued raw microphone buffers even with
deliberate speech and an explicitly selected `MacBook Air Microphone`; a
separate AVFoundation input probe also measured a zero peak. This falsified the
encoder and ScreenCaptureKit-specific hypotheses.

The host then reported `AppleClamshellState = Yes`: it was running closed-lid
with the built-in microphone still selected as the default input. [Apple's
platform security guide](https://support.apple.com/guide/security/secbbd20b00b/web)
documents that Apple silicon Mac laptops disconnect the microphone in hardware
when the lid is closed. The zero track is therefore the expected device state,
not evidence that either capture API discarded valid audio. Product preflight
must identify this condition and require an available external microphone or an
open lid instead of accepting zero-filled callbacks as readiness.

A subsequent 10-second run explicitly selected the connected `EDIFIER R20`
without changing the system default input. ScreenCaptureKit delivered 938
microphone buffers spanning 9.995 seconds with a raw peak of 0.014985; the
resulting mono 48 kHz AAC track was 159,344 bytes at approximately 124 kbps.
This confirms that explicit external-microphone selection and microphone signal
capture work in the same ScreenCaptureKit adapter. The measured first-buffer
offset for that run was 425.850 ms.

The microphone's first presentation timestamp followed the system track by
612.759 ms. The probe preserved both original timestamps. Product storage must
therefore retain source offsets on the shared monotonic timeline rather than
aligning the tracks by the beginning of each encoded file.

Reproduce the non-capturing checks:

```sh
xcode-select -p
xcrun --sdk macosx --show-sdk-version
cd tools/voice-capture-probe
swift build
swift build -c release
./.build/debug/voice-capture-probe
```

### Selected probe design

The probe uses one ScreenCaptureKit stream with `capturesAudio` and
`captureMicrophone` enabled. It registers separate output handlers for
`SCStreamOutputType.audio` and `SCStreamOutputType.microphone`, writes them to
separate M4A files, and records each source's first and last Core Media
presentation timestamp. Keeping the two callback streams separate is consistent
with ADR-0006; a live mixed stream will be a later derived recognition input.

The probe excludes this process's own audio and refuses to overwrite existing
outputs. It does not run from application startup or from automated tests.

### Product adapter decision

The product adapter now uses `screencapturekit` 10.0.3 with its macOS 15 API
feature. By user decision, the app now declares macOS 15.0 as its minimum and
links the adapter in the default product build. It creates one native stream,
registers separate system-audio and
microphone callbacks, and excludes the current process audio. Unlike the
diagnostic probe, it does not persist or apply a microphone device ID: the
configuration explicitly clears any override so each start or resume follows
the current system default input. The user remains responsible for changing
that default in macOS System Settings.

The adapter is wired to the persistent Session Manager and the dual-track WAV
writers. The product can create, pause, resume, end, recover, and play a macOS
recording. Device changes, permission restoration, and long-run drift still
need real-device verification.

### Real-device evidence still required

Run the opt-in command documented in `tools/voice-capture-probe/README.md` while
speaking and playing a known system-audio fixture, then retain the generated
`report.json` with the test notes. Verify:

1. permission denial and permission restoration yield explicit results;
2. output-device changes and microphone removal stop or fault capture visibly;
3. a long run establishes drift instead of inferring synchronization from a
   short sample.

Until those checks pass, macOS dual-source capture remains technically
unverified. The product-wide deployment target is now macOS 15.0 by explicit
user decision.

## Windows dual-source capture

The Rust Windows target is installed, but there is no Windows audio-device
environment in this workspace. WASAPI loopback plus microphone capture, device
changes, packaging dependencies, and clean-machine playback remain unverified.

## Recognition and audio pipeline

### SenseVoice CPU proof (2026-09-23)

`tools/voice-recognition-probe` compiled `sherpa-onnx` 1.13.8 in release mode
on Apple Silicon and decoded the official release's 16 kHz mono examples with
`model.int8.onnx`, `tokens.txt`, automatic language selection, ITN, and two CPU
threads. The model package was kept outside the repository. The measured runs:

| Fixture | Audio | Load | Decode | RTF | Output |
| --- | ---: | ---: | ---: | ---: | --- |
| `test_wavs/zh.wav` | 5.592 s | 1.315 s | 0.866 s | 0.155 | 开饭时间早上9点至下午5点。 |
| `test_wavs/en.wav` | 7.152 s | 1.472 s | 0.980 s | 0.137 | The tribal chieftain called for the boy and presented him with 50 pieces of code. |

The English sample contains an apparent recognition error (`code`); two short
fixtures do not establish meeting accuracy or long-run CPU behavior. Downloaded
archive: 155 MiB; extracted int8 ONNX: 241 MiB. Checksums:

- archive SHA-256: `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`
- ONNX SHA-256: `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`
- tokens SHA-256: `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc`

The [sherpa-onnx Tauri example](https://k2-fsa.github.io/sherpa/onnx/tauri/vad-asr-mic.html)
documents this model/runtime combination. The model archive's `LICENSE` points
to FunASR; before product distribution, retain the exact model attribution and
check the [FunASR model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)
for the packaged conversion. The probe verifies local inference only. It is not
yet connected to the product session, model manager, or Transcript.

FSMN-VAD, Paraformer streaming/final events, gap recovery, AEC, resampling,
and long-run performance remain without executable product evidence. Do not use
the capture or recognition probe as evidence for those capabilities.

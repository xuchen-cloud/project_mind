# macOS dual-source Voice Record probe

This opt-in diagnostic validates the VR-01 macOS capture path without wiring
capture into the application. It uses one ScreenCaptureKit stream and writes
the system-audio and microphone outputs to separate M4A tracks, plus a JSON
report containing their monotonic presentation timestamps.

Requirements:

- macOS 15 or newer;
- an SDK that declares `SCStreamConfiguration.captureMicrophone`;
- Microphone and Screen & System Audio Recording permissions.

Building does not request permissions or start capture:

```sh
cd tools/voice-capture-probe
swift build
```

Run a deliberate 10-second test while speaking and playing known system audio:

```sh
swift run voice-capture-probe \
  --record \
  --duration 10 \
  --microphone "EDIFIER R20" \
  --output "$TMPDIR/project-mind-voice-probe"
```

The output directory must not already contain `system.m4a` or
`microphone.m4a`; the probe refuses to overwrite them. Confirm that both files
are playable and inspect `report.json` for non-zero buffer counts, durations,
file sizes, raw peak amplitudes, and the first-buffer timestamp offset. Silence
in the system track is valid when no system audio was playing and must not be
treated as a missing device.

Use the microphone-only differential probe when the microphone track contains
buffers but its raw peak is zero:

```sh
swift run microphone-input-probe --record
```

It exits successfully only when AVFoundation observes a non-zero input sample.
On Apple silicon and T2 Mac laptops, the built-in microphone is disconnected in
hardware while the lid is closed. Open the lid or explicitly choose a working
external microphone before treating a zero track as an adapter defect.
`--microphone` selects that device for the probe only and does not change the
system-wide default input.

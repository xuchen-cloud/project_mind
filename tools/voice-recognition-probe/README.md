# SenseVoice local runtime probe

This opt-in tool verifies the fixed `sherpa-onnx` 1.13.8 CPU runtime and the
SenseVoice int8 model before either is added to the product. It reads only a
WAV supplied on the command line and does not access recording devices.

Use the model package named
`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` from the
[sherpa-onnx model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models).
Extract it outside this repository. It contains `model.int8.onnx`,
`tokens.txt`, and short example WAV files.

```sh
cargo run --manifest-path tools/voice-recognition-probe/Cargo.toml --release -- \
  /absolute/path/to/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 \
  /absolute/path/to/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav
```

The probe reports model load time, decode time, and real-time factor. It is a
technical experiment, not the application recognition worker. FSMN-VAD,
live capture mixing, model integrity checks, and Windows packaging remain
separate acceptance work.

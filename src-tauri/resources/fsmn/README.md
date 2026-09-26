# Fixed FSMN-VAD model

Source: https://huggingface.co/funasr/fsmn-vad-onnx/tree/f6e9fbb4cefa7397216c763f21307993f147f585 (FunASR; the pinned model card declares Apache-2.0, whose text is included in LICENSE).

- model.onnx SHA-256: 756887ce01695a9bb00dd85ca0f743653de03b18ba54d2e9ef4f4bb9b3edbf9f
- vad.mvn SHA-256: 6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754
- Runtime: extract-speech 0.9.1, Candle CPU ONNX evaluation; no runtime download or Python.
- Frontend: 16 kHz mono, 80-bin fbank, Hamming 25 ms / 10 ms, LFR 5/1, fixed model CMVN.
- Window: 1.02 s, advanced by 30 ms, inference every 90 ms; threshold 0.6, recent nine frame scores; energy support rejects isolated clicks.

Files are embedded in the executable and materialized only while initializing the model. Existing SenseVoice import remains unchanged.

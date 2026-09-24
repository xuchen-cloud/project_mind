//! Native capture boundary — VR-02, VR-05, VR-06.
#[cfg(target_os = "macos")]
pub mod macos;

// TODO: macOS adapter using a verified recent SDK; Windows WASAPI loopback adapter.
// Probe actual source readiness (silent output is not a missing device).
// On supported Mac laptops, detect the closed-lid hardware microphone cutoff;
// receiving zero-filled callbacks does not mean the built-in mic is usable.
// Keep callbacks nonblocking; send bounded AudioFrame queues to writers/VAD.
// Preserve raw synchronized source tracks; resample/mix/AEC only on ASR branch.
// Device changes, missing callbacks, sleep and permission loss pause BOTH sources.
// No adapter should fall back to microphone-only or start during app initialization.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSource {
    Microphone,
    System,
}

/// Product capture follows the input selected in macOS System Settings.
/// Keeping this explicit prevents a diagnostic device override from leaking
/// into the persisted product configuration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MicrophoneSelection {
    #[default]
    SystemDefault,
}

impl MicrophoneSelection {
    pub const fn device_id_override(self) -> Option<&'static str> {
        match self {
            Self::SystemDefault => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
#[cfg(any(test, target_os = "macos"))]
pub(crate) struct PcmBuffer<'a> {
    pub channels: u32,
    pub bytes: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(any(test, target_os = "macos"))]
pub(crate) enum PcmDecodeError {
    NoBuffers,
    InvalidChannelCount,
    PartialFloat,
    UnequalPlanarFrames,
    UnsupportedLayout,
}

/// Normalize packed signed 16-bit input without reinterpreting integer bits as floats.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn decode_i16_pcm(buffers: &[PcmBuffer<'_>]) -> Result<Vec<f32>, PcmDecodeError> {
    let mut planes = Vec::with_capacity(buffers.len());
    for buffer in buffers {
        if buffer.bytes.len() % 2 != 0 {
            return Err(PcmDecodeError::PartialFloat);
        }
        let bytes = buffer
            .bytes
            .chunks_exact(2)
            .flat_map(|bytes| {
                (f32::from(i16::from_ne_bytes([bytes[0], bytes[1]])) / 32768.0).to_ne_bytes()
            })
            .collect::<Vec<_>>();
        planes.push(bytes);
    }
    let views = buffers
        .iter()
        .zip(&planes)
        .map(|(buffer, bytes)| PcmBuffer {
            channels: buffer.channels,
            bytes,
        })
        .collect::<Vec<_>>();
    decode_f32_pcm(&views)
}

#[cfg(test)]
mod integer_pcm_tests {
    use super::*;
    #[test]
    fn microphone_integer_samples_keep_frame_count_and_amplitude() {
        let bytes = [-32768_i16, -1, 0, 16384, 32767]
            .into_iter()
            .flat_map(i16::to_ne_bytes)
            .collect::<Vec<_>>();
        let samples = decode_i16_pcm(&[PcmBuffer {
            channels: 1,
            bytes: &bytes,
        }])
        .unwrap();
        assert_eq!(
            samples,
            vec![-1.0, -1.0 / 32768.0, 0.0, 0.5, 32767.0 / 32768.0]
        );
    }
}

/// Normalize native-endian Float32 PCM from one
/// interleaved buffer or one-buffer-per-channel layout into the interleaved
/// representation used by `AudioFrame`.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn decode_f32_pcm(buffers: &[PcmBuffer<'_>]) -> Result<Vec<f32>, PcmDecodeError> {
    if buffers.is_empty() {
        return Err(PcmDecodeError::NoBuffers);
    }
    if buffers
        .iter()
        .any(|buffer| buffer.channels == 0 || buffer.bytes.len() % size_of::<f32>() != 0)
    {
        return Err(if buffers.iter().any(|buffer| buffer.channels == 0) {
            PcmDecodeError::InvalidChannelCount
        } else {
            PcmDecodeError::PartialFloat
        });
    }

    let decode = |bytes: &[u8]| -> Vec<f32> {
        bytes
            .chunks_exact(size_of::<f32>())
            .map(|chunk| f32::from_ne_bytes(chunk.try_into().expect("exact float chunk")))
            .collect()
    };

    if buffers.len() == 1 {
        return Ok(decode(buffers[0].bytes));
    }
    if buffers.iter().any(|buffer| buffer.channels != 1) {
        return Err(PcmDecodeError::UnsupportedLayout);
    }
    let frame_count = buffers[0].bytes.len() / size_of::<f32>();
    if buffers
        .iter()
        .any(|buffer| buffer.bytes.len() / size_of::<f32>() != frame_count)
    {
        return Err(PcmDecodeError::UnequalPlanarFrames);
    }

    let planes = buffers
        .iter()
        .map(|buffer| decode(buffer.bytes))
        .collect::<Vec<_>>();
    let mut samples = Vec::with_capacity(frame_count * planes.len());
    for frame in 0..frame_count {
        for plane in &planes {
            samples.push(plane[frame]);
        }
    }
    Ok(samples)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioFrame {
    pub source: AudioSource,
    pub epoch: u64,
    pub sequence: u64,
    pub start_sample: u64,
    pub captured_at_ns: u64,
    pub clock_error_ns: i64,
    media_position_ns: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

impl AudioFrame {
    pub fn media_position_ns(&self) -> u64 {
        self.media_position_ns
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioContractError {
    InvalidSampleRate,
    InvalidChannelCount,
    EmptySamples,
    PartialFrame,
    ClockWentBackwards,
    SampleCounterOverflow,
    SequenceOverflow,
}

pub struct SourceTimeline {
    source: AudioSource,
    epoch: u64,
    sample_rate: u32,
    channels: u16,
    session_started_at_ns: u64,
    source_started_at_ns: Option<u64>,
    next_sequence: u64,
    next_sample: u64,
    last_captured_at_ns: Option<u64>,
}

impl SourceTimeline {
    pub fn new(
        source: AudioSource,
        epoch: u64,
        session_started_at_ns: u64,
        sample_rate: u32,
        channels: u16,
    ) -> Result<Self, AudioContractError> {
        if sample_rate == 0 {
            return Err(AudioContractError::InvalidSampleRate);
        }
        if channels == 0 {
            return Err(AudioContractError::InvalidChannelCount);
        }
        Ok(Self {
            source,
            epoch,
            sample_rate,
            channels,
            session_started_at_ns,
            source_started_at_ns: None,
            next_sequence: 0,
            next_sample: 0,
            last_captured_at_ns: None,
        })
    }

    pub fn stamp(
        &mut self,
        captured_at_ns: u64,
        samples: Vec<f32>,
    ) -> Result<AudioFrame, AudioContractError> {
        if captured_at_ns < self.session_started_at_ns
            || self
                .last_captured_at_ns
                .is_some_and(|previous| captured_at_ns < previous)
        {
            return Err(AudioContractError::ClockWentBackwards);
        }
        if samples.is_empty() {
            return Err(AudioContractError::EmptySamples);
        }
        let channels = usize::from(self.channels);
        if !samples.len().is_multiple_of(channels) {
            return Err(AudioContractError::PartialFrame);
        }
        let frame_count = u64::try_from(samples.len() / channels)
            .map_err(|_| AudioContractError::SampleCounterOverflow)?;
        let next_sample = self
            .next_sample
            .checked_add(frame_count)
            .ok_or(AudioContractError::SampleCounterOverflow)?;
        let next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(AudioContractError::SequenceOverflow)?;
        let source_started_at_ns = self.source_started_at_ns.unwrap_or(captured_at_ns);
        let source_offset_ns = source_started_at_ns - self.session_started_at_ns;
        let sample_position_ns =
            u128::from(self.next_sample) * 1_000_000_000 / u128::from(self.sample_rate);
        let media_position_ns = u128::from(source_offset_ns)
            .saturating_add(sample_position_ns)
            .min(u128::from(u64::MAX)) as u64;
        let expected_presentation_ns = u128::from(source_started_at_ns)
            .saturating_add(sample_position_ns)
            .min(u128::from(u64::MAX)) as u64;
        let clock_error = i128::from(captured_at_ns) - i128::from(expected_presentation_ns);
        let clock_error_ns = clock_error.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64;
        let frame = AudioFrame {
            source: self.source,
            epoch: self.epoch,
            sequence: self.next_sequence,
            start_sample: self.next_sample,
            captured_at_ns,
            clock_error_ns,
            media_position_ns,
            sample_rate: self.sample_rate,
            channels: self.channels,
            samples,
        };
        self.next_sample = next_sample;
        self.next_sequence = next_sequence;
        self.source_started_at_ns = Some(source_started_at_ns);
        self.last_captured_at_ns = Some(captured_at_ns);
        Ok(frame)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioQueueError {
    ZeroCapacity,
}

#[derive(Debug, PartialEq)]
pub enum AudioIngressError {
    Backpressure(AudioFrame),
    Closed(AudioFrame),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioReceiveError {
    Empty,
    Closed,
}

pub struct AudioFrameSink {
    sender: tokio::sync::mpsc::Sender<AudioFrame>,
}

impl AudioFrameSink {
    pub fn try_push(&self, frame: AudioFrame) -> Result<(), AudioIngressError> {
        self.sender.try_send(frame).map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(frame) => {
                AudioIngressError::Backpressure(frame)
            }
            tokio::sync::mpsc::error::TrySendError::Closed(frame) => {
                AudioIngressError::Closed(frame)
            }
        })
    }
}

pub struct AudioFrameStream {
    receiver: tokio::sync::mpsc::Receiver<AudioFrame>,
}

impl AudioFrameStream {
    pub fn try_next(&mut self) -> Result<AudioFrame, AudioReceiveError> {
        self.receiver.try_recv().map_err(|error| match error {
            tokio::sync::mpsc::error::TryRecvError::Empty => AudioReceiveError::Empty,
            tokio::sync::mpsc::error::TryRecvError::Disconnected => AudioReceiveError::Closed,
        })
    }

    pub async fn next(&mut self) -> Option<AudioFrame> {
        self.receiver.recv().await
    }

    pub fn blocking_next(&mut self) -> Option<AudioFrame> {
        self.receiver.blocking_recv()
    }
}

pub fn bounded_audio_frames(
    capacity: usize,
) -> Result<(AudioFrameSink, AudioFrameStream), AudioQueueError> {
    if capacity == 0 {
        return Err(AudioQueueError::ZeroCapacity);
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
    Ok((AudioFrameSink { sender }, AudioFrameStream { receiver }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_timeline_uses_sample_positions_instead_of_callback_arrival_time() {
        let mut timeline =
            SourceTimeline::new(AudioSource::Microphone, 7, 1_000_000_000, 48_000, 1)
                .expect("valid microphone timeline");

        let first = timeline
            .stamp(1_000_000_000, vec![0.0; 480])
            .expect("first frame");
        let second = timeline
            .stamp(1_012_000_000, vec![0.0; 480])
            .expect("second frame with callback jitter");

        assert_eq!(first.sequence, 0);
        assert_eq!(first.start_sample, 0);
        assert_eq!(first.media_position_ns(), 0);
        assert_eq!(second.sequence, 1);
        assert_eq!(second.start_sample, 480);
        assert_eq!(second.media_position_ns(), 10_000_000);
        assert_eq!(second.captured_at_ns, 1_012_000_000);
        assert_eq!(second.clock_error_ns, 2_000_000);
    }

    #[test]
    fn source_timeline_rejects_a_regressing_monotonic_timestamp_without_advancing() {
        let mut timeline =
            SourceTimeline::new(AudioSource::System, 9, 10_000, 48_000, 2).expect("valid timeline");
        timeline
            .stamp(20_000, vec![0.0; 960])
            .expect("first stereo frame");

        assert_eq!(
            timeline.stamp(19_999, vec![0.0; 960]),
            Err(AudioContractError::ClockWentBackwards)
        );
        let next = timeline
            .stamp(30_000, vec![0.0; 960])
            .expect("timeline remains usable");
        assert_eq!(next.sequence, 1);
        assert_eq!(next.start_sample, 480);
    }

    #[test]
    fn a_full_raw_audio_queue_returns_the_frame_instead_of_silently_dropping_it() {
        let (sink, mut stream) = bounded_audio_frames(1).expect("positive queue capacity");
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 11, 1_000, 48_000, 1)
            .expect("valid timeline");
        let first = timeline.stamp(1_000, vec![0.1; 480]).unwrap();
        let second = timeline.stamp(2_000, vec![0.2; 480]).unwrap();

        sink.try_push(first).expect("first frame fits");
        let rejected = sink.try_push(second).expect_err("queue must be full");

        let AudioIngressError::Backpressure(rejected_frame) = rejected else {
            panic!("open full queue must report backpressure");
        };
        assert_eq!(rejected_frame.sequence, 1);
        assert_eq!(stream.try_next().unwrap().sequence, 0);
    }

    #[test]
    fn source_timelines_preserve_first_buffer_offsets_from_the_shared_session_origin() {
        let mut system =
            SourceTimeline::new(AudioSource::System, 12, 1_000_000_000, 48_000, 2).unwrap();
        let mut microphone =
            SourceTimeline::new(AudioSource::Microphone, 12, 1_000_000_000, 48_000, 1).unwrap();

        let system_frame = system.stamp(1_100_000_000, vec![0.0; 960]).unwrap();
        let microphone_frame = microphone.stamp(1_400_000_000, vec![0.0; 480]).unwrap();

        assert_eq!(system_frame.media_position_ns(), 100_000_000);
        assert_eq!(microphone_frame.media_position_ns(), 400_000_000);
    }

    #[test]
    fn microphone_capture_defaults_to_the_current_system_input() {
        let selection = MicrophoneSelection::default();

        assert_eq!(selection, MicrophoneSelection::SystemDefault);
        assert_eq!(selection.device_id_override(), None);
    }

    #[test]
    fn interleaved_float_pcm_is_copied_without_reordering() {
        let bytes = [0.25_f32, -0.5, 0.75, -1.0]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect::<Vec<_>>();

        let samples = decode_f32_pcm(&[PcmBuffer {
            channels: 2,
            bytes: &bytes,
        }])
        .expect("valid stereo PCM");

        assert_eq!(samples, vec![0.25, -0.5, 0.75, -1.0]);
    }

    #[test]
    fn planar_float_pcm_is_interleaved_for_the_shared_audio_contract() {
        let left = [0.1_f32, 0.2]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect::<Vec<_>>();
        let right = [-0.1_f32, -0.2]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect::<Vec<_>>();

        let samples = decode_f32_pcm(&[
            PcmBuffer {
                channels: 1,
                bytes: &left,
            },
            PcmBuffer {
                channels: 1,
                bytes: &right,
            },
        ])
        .expect("valid planar stereo PCM");

        assert_eq!(samples, vec![0.1, -0.1, 0.2, -0.2]);
    }
}

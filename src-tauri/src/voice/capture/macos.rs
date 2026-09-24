use super::{
    bounded_audio_frames, decode_f32_pcm, decode_i16_pcm, AudioFrameSink, AudioFrameStream,
    AudioIngressError, AudioSource, MicrophoneSelection, PcmBuffer, SourceTimeline,
};
use screencapturekit::{
    audio_devices::AudioInputDevice,
    cm::CMSampleBufferExt,
    error::SCError,
    prelude::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutputTrait,
        SCStreamOutputType,
    },
    stream::delegate_trait::ErrorHandler,
};
use std::{
    fmt,
    sync::{Arc, Mutex},
    time::Instant,
};

const CAPTURE_SAMPLE_RATE: u32 = 48_000;
const CONFIGURED_CHANNELS: u16 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacCaptureFault {
    Decode { source: AudioSource },
    Timeline { source: AudioSource },
    Backpressure { source: AudioSource },
    ConsumerClosed { source: AudioSource },
    StreamStopped(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacCaptureError {
    NoDefaultMicrophone,
    NoDisplay,
    InvalidQueueCapacity,
    ShareableContent(String),
    HandlerRegistration(AudioSource),
    Start(String),
    Stop(String),
}

impl fmt::Display for MacCaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDefaultMicrophone => formatter.write_str("no system default microphone"),
            Self::NoDisplay => formatter.write_str("no display available for system audio capture"),
            Self::InvalidQueueCapacity => {
                formatter.write_str("audio queue capacity must be positive")
            }
            Self::ShareableContent(error) => {
                write!(formatter, "cannot read shareable content: {error}")
            }
            Self::HandlerRegistration(source) => {
                write!(formatter, "cannot register {source:?} capture callback")
            }
            Self::Start(error) => write!(formatter, "cannot start capture: {error}"),
            Self::Stop(error) => write!(formatter, "cannot stop capture: {error}"),
        }
    }
}

impl std::error::Error for MacCaptureError {}

pub struct MacCaptureOutputs {
    pub microphone: AudioFrameStream,
    pub system: AudioFrameStream,
    pub recognition_microphone: Option<AudioFrameStream>,
    pub recognition_system: Option<AudioFrameStream>,
    pub faults: tokio::sync::mpsc::Receiver<MacCaptureFault>,
}

/// Owns the native stream. Dropping it requests a clean stop and releases all
/// ScreenCaptureKit callbacks and native handles.
pub struct MacCaptureSession {
    stream: SCStream,
    running: bool,
}

impl MacCaptureSession {
    pub fn preflight() -> Result<(), MacCaptureError> {
        if AudioInputDevice::default_device().is_none() {
            return Err(MacCaptureError::NoDefaultMicrophone);
        }
        let content = SCShareableContent::get()
            .map_err(|error| MacCaptureError::ShareableContent(error.to_string()))?;
        if content.displays().is_empty() {
            return Err(MacCaptureError::NoDisplay);
        }
        Ok(())
    }

    pub fn start(
        epoch: u64,
        queue_capacity: usize,
        recognize: bool,
    ) -> Result<(Self, MacCaptureOutputs), MacCaptureError> {
        if queue_capacity == 0 {
            return Err(MacCaptureError::InvalidQueueCapacity);
        }
        Self::preflight()?;

        let content = SCShareableContent::get()
            .map_err(|error| MacCaptureError::ShareableContent(error.to_string()))?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or(MacCaptureError::NoDisplay)?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        let mut configuration = SCStreamConfiguration::new()
            .with_captures_audio(true)
            .with_captures_microphone(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(CAPTURE_SAMPLE_RATE as i32)
            .with_channel_count(i32::from(CONFIGURED_CHANNELS));
        apply_microphone_selection(&mut configuration, MicrophoneSelection::default());

        let (microphone_sink, microphone) = bounded_audio_frames(queue_capacity)
            .map_err(|_| MacCaptureError::InvalidQueueCapacity)?;
        let (system_sink, system) = bounded_audio_frames(queue_capacity)
            .map_err(|_| MacCaptureError::InvalidQueueCapacity)?;
        let (recognition_microphone_sink, recognition_microphone) = if recognize {
            let (sink, stream) = bounded_audio_frames(queue_capacity * 4)
                .map_err(|_| MacCaptureError::InvalidQueueCapacity)?;
            (Some(sink), Some(stream))
        } else {
            (None, None)
        };
        let (recognition_system_sink, recognition_system) = if recognize {
            let (sink, stream) = bounded_audio_frames(queue_capacity * 4)
                .map_err(|_| MacCaptureError::InvalidQueueCapacity)?;
            (Some(sink), Some(stream))
        } else {
            (None, None)
        };
        let (fault_sink, faults) = tokio::sync::mpsc::channel(queue_capacity);
        let started_at = Instant::now();

        let delegate_faults = fault_sink.clone();
        let delegate = ErrorHandler::new(move |error: SCError| {
            let _ = delegate_faults.try_send(MacCaptureFault::StreamStopped(error.to_string()));
        });
        let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate);

        register_handler(
            &mut stream,
            TrackHandler::new(
                AudioSource::System,
                epoch,
                started_at,
                system_sink,
                recognition_system_sink,
                fault_sink.clone(),
            ),
            SCStreamOutputType::Audio,
        )?;
        register_handler(
            &mut stream,
            TrackHandler::new(
                AudioSource::Microphone,
                epoch,
                started_at,
                microphone_sink,
                recognition_microphone_sink,
                fault_sink,
            ),
            SCStreamOutputType::Microphone,
        )?;

        stream
            .start_capture()
            .map_err(|error| MacCaptureError::Start(error.to_string()))?;

        Ok((
            Self {
                stream,
                running: true,
            },
            MacCaptureOutputs {
                microphone,
                system,
                recognition_microphone,
                recognition_system,
                faults,
            },
        ))
    }

    pub fn stop(&mut self) -> Result<(), MacCaptureError> {
        if !self.running {
            return Ok(());
        }
        self.stream
            .stop_capture()
            .map_err(|error| MacCaptureError::Stop(error.to_string()))?;
        self.running = false;
        Ok(())
    }
}

impl Drop for MacCaptureSession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn apply_microphone_selection(
    configuration: &mut SCStreamConfiguration,
    selection: MicrophoneSelection,
) {
    match selection.device_id_override() {
        Some(device_id) => {
            configuration.set_microphone_capture_device_id(device_id);
        }
        None => {
            configuration.clear_microphone_capture_device_id();
        }
    }
}

fn register_handler(
    stream: &mut SCStream,
    handler: TrackHandler,
    output_type: SCStreamOutputType,
) -> Result<(), MacCaptureError> {
    let source = handler.source;
    stream
        .add_output_handler(handler, output_type)
        .map(|_| ())
        .ok_or(MacCaptureError::HandlerRegistration(source))
}

struct TrackHandler {
    source: AudioSource,
    epoch: u64,
    started_at: Instant,
    timeline: Arc<Mutex<Option<SourceTimeline>>>,
    frames: AudioFrameSink,
    recognition: Option<AudioFrameSink>,
    faults: tokio::sync::mpsc::Sender<MacCaptureFault>,
}

impl TrackHandler {
    fn new(
        source: AudioSource,
        epoch: u64,
        started_at: Instant,
        frames: AudioFrameSink,
        recognition: Option<AudioFrameSink>,
        faults: tokio::sync::mpsc::Sender<MacCaptureFault>,
    ) -> Self {
        Self {
            source,
            epoch,
            started_at,
            timeline: Arc::new(Mutex::new(None)),
            frames,
            recognition,
            faults,
        }
    }

    fn report(&self, fault: MacCaptureFault) {
        let _ = self.faults.try_send(fault);
    }
}

impl SCStreamOutputTrait for TrackHandler {
    fn did_output_sample_buffer(
        &self,
        sample: screencapturekit::cm::CMSampleBuffer,
        _output_type: SCStreamOutputType,
    ) {
        let Some(format) = sample.format_description() else {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        };
        let sample_rate = format.audio_sample_rate().unwrap_or(0.0);
        if !sample_rate.is_finite()
            || sample_rate <= 0.0
            || sample_rate > u32::MAX as f64
            || format.audio_is_big_endian()
        {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        }
        let Some(buffers) = sample.audio_buffer_list() else {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        };
        let channels = buffers.iter().try_fold(0_u32, |total, buffer| {
            total.checked_add(buffer.number_channels())
        });
        let Some(channels) = channels.and_then(|value| u16::try_from(value).ok()) else {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        };
        let views = buffers
            .iter()
            .map(|buffer| PcmBuffer {
                channels: buffer.number_channels(),
                bytes: buffer.data(),
            })
            .collect::<Vec<_>>();
        let planar = format.audio_format_flags().unwrap_or(0) & 32 != 0;
        let bytes_per_sample = format.audio_bits_per_channel().unwrap_or(0) / 8;
        let expected_bytes_per_frame =
            bytes_per_sample * if planar { 1 } else { u32::from(channels) };
        if format.audio_channel_count() != Some(u32::from(channels))
            || format.audio_bytes_per_frame() != Some(expected_bytes_per_frame)
        {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        }
        let decoded = match (format.audio_is_float(), format.audio_bits_per_channel()) {
            (true, Some(32)) => decode_f32_pcm(&views),
            (false, Some(16)) if format.audio_format_flags().unwrap_or(0) & 4 != 0 => {
                decode_i16_pcm(&views)
            }
            _ => Err(super::PcmDecodeError::UnsupportedLayout),
        };
        let Ok(samples) = decoded else {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        };
        let captured_at_ns = self
            .started_at
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        let mut timeline = self
            .timeline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if timeline.is_none() {
            *timeline =
                SourceTimeline::new(self.source, self.epoch, 0, sample_rate as u32, channels).ok();
        }
        let Some(timeline) = timeline.as_mut() else {
            self.report(MacCaptureFault::Timeline {
                source: self.source,
            });
            return;
        };
        if timeline.sample_rate != sample_rate as u32 || timeline.channels != channels {
            self.report(MacCaptureFault::Decode {
                source: self.source,
            });
            return;
        }
        let Ok(frame) = timeline.stamp(captured_at_ns, samples) else {
            self.report(MacCaptureFault::Timeline {
                source: self.source,
            });
            return;
        };
        if let Some(recognition) = &self.recognition {
            if let Err(error) = recognition.try_push(frame.clone()) {
                self.report(match error {
                    AudioIngressError::Backpressure(_) => MacCaptureFault::Backpressure {
                        source: self.source,
                    },
                    AudioIngressError::Closed(_) => MacCaptureFault::ConsumerClosed {
                        source: self.source,
                    },
                });
            }
        }
        if let Err(error) = self.frames.try_push(frame) {
            self.report(match error {
                AudioIngressError::Backpressure(_) => MacCaptureFault::Backpressure {
                    source: self.source,
                },
                AudioIngressError::Closed(_) => MacCaptureFault::ConsumerClosed {
                    source: self.source,
                },
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_configuration_uses_system_default_microphone_and_separate_audio_outputs() {
        let mut configuration = SCStreamConfiguration::new()
            .with_captures_audio(true)
            .with_captures_microphone(true);

        apply_microphone_selection(&mut configuration, MicrophoneSelection::SystemDefault);

        assert!(configuration.captures_audio());
        assert!(configuration.captures_microphone());
        assert_eq!(configuration.microphone_capture_device_id(), None);
    }

    #[test]
    fn zero_capacity_is_rejected_before_native_permission_or_device_work() {
        assert_eq!(
            MacCaptureSession::start(1, 0, false).err(),
            Some(MacCaptureError::InvalidQueueCapacity)
        );
    }
}

//! WASAPI shared capture. COM objects stay on one owner thread; raw tracks have
//! independent bounded queues. Real Windows device/installer acceptance is pending.
use super::{bounded_audio_frames, AudioFrame, AudioFrameSink, AudioFrameStream, AudioSource};
use anyhow::{anyhow, Result};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Media::Audio::*,
    System::{Com::*, Performance::*},
};

const RATE: u64 = 48_000;
const CHANNELS: u16 = 2;

pub type WindowsCaptureFault = String;
pub struct WindowsCaptureOutputs {
    pub microphone: AudioFrameStream,
    pub system: AudioFrameStream,
    pub activity_microphone: AudioFrameStream,
    pub activity_system: AudioFrameStream,
    pub recognition_microphone: Option<AudioFrameStream>,
    pub recognition_system: Option<AudioFrameStream>,
    pub faults: tokio::sync::mpsc::Receiver<WindowsCaptureFault>,
}

pub struct WindowsCaptureSession {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl WindowsCaptureSession {
    pub fn preflight() -> Result<()> {
        thread::spawn(|| -> Result<()> {
            let _com = Com::new()?;
            let devices = unsafe {
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)?
            };
            unsafe {
                devices.GetDefaultAudioEndpoint(eCapture, eConsole)?;
                devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
            }
            Ok(())
        })
        .join()
        .map_err(|_| anyhow!("Windows audio preflight panicked"))?
    }
    pub fn start(
        epoch: u64,
        capacity: usize,
        recognize: bool,
    ) -> Result<(Self, WindowsCaptureOutputs)> {
        let queue = || bounded_audio_frames(capacity).map_err(|error| anyhow!("{error:?}"));
        let (mic, microphone) = queue()?;
        let (sys, system) = queue()?;
        let (mic_activity, activity_microphone) = queue()?;
        let (sys_activity, activity_system) = queue()?;
        let (mic_asr, recognition_microphone) = if recognize {
            let (a, b) = queue()?;
            (Some(a), Some(b))
        } else {
            (None, None)
        };
        let (sys_asr, recognition_system) = if recognize {
            let (a, b) = queue()?;
            (Some(a), Some(b))
        } else {
            (None, None)
        };
        let (faults_send, faults) = tokio::sync::mpsc::channel(4);
        let (ready_send, ready) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let join = thread::Builder::new()
            .name("voice-wasapi".into())
            .spawn(move || {
                let result = run(
                    epoch,
                    &stopped,
                    (mic, mic_activity, mic_asr),
                    (sys, sys_activity, sys_asr),
                    &ready_send,
                );
                if let Err(error) = result {
                    let detail = error.to_string();
                    let _ = ready_send.try_send(Err(detail.clone()));
                    let _ = faults_send.try_send(detail);
                }
            })?;
        let capture = Self {
            stop,
            join: Some(join),
        };
        match ready.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok((
                capture,
                WindowsCaptureOutputs {
                    microphone,
                    system,
                    activity_microphone,
                    activity_system,
                    recognition_microphone,
                    recognition_system,
                    faults,
                },
            )),
            result => {
                capture.stop.store(true, Ordering::Release);
                Err(anyhow!("Windows audio startup failed: {result:?}"))
            }
        }
    }
    pub fn stop(&mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            join.join()
                .map_err(|_| anyhow!("Windows audio thread panicked"))?;
        }
        Ok(())
    }
}
impl Drop for WindowsCaptureSession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
struct Com;
impl Com {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
type Sinks = (AudioFrameSink, AudioFrameSink, Option<AudioFrameSink>);
struct Track {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    device_id: String,
    source: AudioSource,
    sinks: Sinks,
    next_sample: u64,
    sequence: u64,
    seen: bool,
    last_packet: Instant,
}
impl Drop for Track {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}
fn device_id(device: &IMMDevice) -> Result<String> {
    unsafe {
        let id = device.GetId()?;
        let result = id.to_string();
        CoTaskMemFree(Some(id.0.cast()));
        Ok(result?)
    }
}
impl Track {
    fn new(devices: &IMMDeviceEnumerator, source: AudioSource, sinks: Sinks) -> Result<Self> {
        unsafe {
            let device = devices.GetDefaultAudioEndpoint(
                if source == AudioSource::Microphone {
                    eCapture
                } else {
                    eRender
                },
                eConsole,
            )?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let format = WAVEFORMATEX {
                wFormatTag: 3,
                nChannels: CHANNELS,
                nSamplesPerSec: RATE as u32,
                nAvgBytesPerSec: RATE as u32 * 8,
                nBlockAlign: 8,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
                | if source == AudioSource::System {
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                } else {
                    0
                };
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, &format, None)?;
            let capture = client.GetService::<IAudioCaptureClient>()?;
            Ok(Self {
                client,
                capture,
                device_id: device_id(&device)?,
                source,
                sinks,
                next_sample: 0,
                sequence: 0,
                seen: false,
                last_packet: Instant::now(),
            })
        }
    }
    fn send(&mut self, epoch: u64, samples: &[f32]) -> Result<()> {
        for chunk in samples.chunks(480 * usize::from(CHANNELS)) {
            let frame = AudioFrame {
                source: self.source,
                epoch,
                sequence: self.sequence,
                start_sample: self.next_sample,
                captured_at_ns: self.next_sample * 1_000_000_000 / RATE,
                clock_error_ns: 0,
                media_position_ns: self.next_sample * 1_000_000_000 / RATE,
                sample_rate: RATE as u32,
                channels: CHANNELS,
                samples: chunk.to_vec(),
            };
            self.next_sample += chunk.len() as u64 / u64::from(CHANNELS);
            self.sequence += 1;
            self.sinks
                .0
                .try_push(frame.clone())
                .map_err(|_| anyhow!("{:?} raw audio queue unavailable", self.source))?;
            self.sinks
                .1
                .try_push(frame.clone())
                .map_err(|_| anyhow!("{:?} activity queue unavailable", self.source))?;
            if let Some(asr) = &self.sinks.2 {
                let _ = asr.try_push(frame);
            }
        }
        Ok(())
    }
    fn silence_to(&mut self, epoch: u64, sample: u64) -> Result<()> {
        while self.next_sample < sample {
            self.send(
                epoch,
                &vec![0.0; (sample - self.next_sample).min(480) as usize * usize::from(CHANNELS)],
            )?;
        }
        Ok(())
    }
    fn drain(&mut self, epoch: u64, started: u64) -> Result<()> {
        unsafe {
            while self.capture.GetNextPacketSize()? > 0 {
                let (mut data, mut frames, mut flags, mut timestamp) =
                    (std::ptr::null_mut(), 0, 0, 0);
                self.capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    None,
                    Some(&mut timestamp),
                )?;
                // Silent WASAPI packets can have a null data pointer. Never dereference it.
                let samples = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    vec![0.0; frames as usize * 2]
                } else if data.is_null() {
                    self.capture.ReleaseBuffer(frames)?;
                    return Err(anyhow!("WASAPI returned a null audio buffer"));
                } else {
                    std::slice::from_raw_parts(data.cast::<f32>(), frames as usize * 2).to_vec()
                };
                self.capture.ReleaseBuffer(frames)?;
                if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0
                    || (self.seen && flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0)
                {
                    return Err(anyhow!("{:?} audio timeline interrupted", self.source));
                }
                let position = timestamp.saturating_sub(started) * RATE / 10_000_000;
                if position + 96 < self.next_sample {
                    return Err(anyhow!("{:?} late audio packet", self.source));
                }
                if position > self.next_sample + 96 {
                    self.silence_to(epoch, position)?;
                }
                self.send(epoch, &samples)?;
                self.seen = true;
                self.last_packet = Instant::now();
            }
        }
        Ok(())
    }
}
fn qpc(frequency: i64) -> Result<u64> {
    let mut value = 0;
    unsafe {
        QueryPerformanceCounter(&mut value)?;
    }
    Ok((value as u128 * 10_000_000 / frequency as u128) as u64)
}
fn run(
    epoch: u64,
    stop: &AtomicBool,
    microphone: Sinks,
    system: Sinks,
    ready: &mpsc::SyncSender<std::result::Result<(), String>>,
) -> Result<()> {
    let _com = Com::new()?;
    let devices = unsafe {
        CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)?
    };
    let mut mic = Track::new(&devices, AudioSource::Microphone, microphone)?;
    let mut sys = Track::new(&devices, AudioSource::System, system)?;
    let mut frequency = 0;
    unsafe {
        QueryPerformanceFrequency(&mut frequency)?;
    }
    let started = qpc(frequency)?;
    unsafe {
        mic.client.Start()?;
        sys.client.Start()?;
    }
    ready
        .send(Ok(()))
        .map_err(|_| anyhow!("capture startup cancelled"))?;
    let mut last_check = Instant::now();
    let mut last_tick = Instant::now();
    while !stop.load(Ordering::Acquire) {
        if last_tick.elapsed() > Duration::from_secs(2) {
            return Err(anyhow!(
                "Windows audio interrupted by sleep or scheduling delay"
            ));
        }
        last_tick = Instant::now();
        mic.drain(epoch, started)?;
        sys.drain(epoch, started)?;
        // Render endpoints may emit no callbacks while silent. Leave 100 ms for packet delivery.
        let elapsed = qpc(frequency)?.saturating_sub(started);
        sys.silence_to(epoch, elapsed.saturating_sub(1_000_000) * RATE / 10_000_000)?;
        if mic.last_packet.elapsed() > Duration::from_secs(2) {
            return Err(anyhow!("Windows microphone stopped delivering audio"));
        }
        if last_check.elapsed() > Duration::from_secs(1) {
            for track in [&mic, &sys] {
                let device = unsafe {
                    devices.GetDefaultAudioEndpoint(
                        if track.source == AudioSource::Microphone {
                            eCapture
                        } else {
                            eRender
                        },
                        eConsole,
                    )?
                };
                if device_id(&device)? != track.device_id
                    || unsafe { device.GetState()? } != DEVICE_STATE_ACTIVE
                {
                    return Err(anyhow!(
                        "Windows default audio device changed or disconnected"
                    ));
                }
            }
            last_check = Instant::now();
        }
        thread::sleep(Duration::from_millis(10));
    }
    mic.drain(epoch, started)?;
    sys.drain(epoch, started)?;
    Ok(())
}

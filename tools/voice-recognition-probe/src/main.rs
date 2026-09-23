use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig, Wave};
use std::{env, path::Path, process::ExitCode, time::Instant};

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        return Err("usage: voice-recognition-probe <model-directory> <16-kHz-mono-wav>".into());
    }
    let directory = Path::new(&args[1]);
    let model = directory.join("model.int8.onnx");
    let tokens = directory.join("tokens.txt");
    if !model.is_file() || !tokens.is_file() {
        return Err("model directory must contain model.int8.onnx and tokens.txt".into());
    }
    let wave = Wave::read(&args[2]).ok_or_else(|| "cannot read WAV".to_string())?;
    if wave.sample_rate() != 16_000 {
        return Err(format!(
            "expected 16 kHz WAV; got {} Hz",
            wave.sample_rate()
        ));
    }
    let duration = wave.samples().len() as f64 / f64::from(wave.sample_rate());
    if duration == 0.0 {
        return Err("WAV has no audio".into());
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model.to_string_lossy().into_owned()),
        language: Some("auto".into()),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 2;
    let load_start = Instant::now();
    let recognizer = OfflineRecognizer::create(&config)
        .ok_or_else(|| "SenseVoice model failed to load".to_string())?;
    let load_seconds = load_start.elapsed().as_secs_f64();
    let stream = recognizer.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    let decode_start = Instant::now();
    recognizer.decode(&stream);
    let decode_seconds = decode_start.elapsed().as_secs_f64();
    let result = stream
        .get_result()
        .ok_or_else(|| "recognizer returned no result".to_string())?;
    println!("text: {}", result.text);
    println!("audio_seconds: {duration:.3}");
    println!("load_seconds: {load_seconds:.3}");
    println!("decode_seconds: {decode_seconds:.3}");
    println!("rtf: {:.3}", decode_seconds / duration);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

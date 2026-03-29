use rfd::FileDialog;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
struct CommandResult {
    command: String,
    log: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LosslessCutPayload {
    source_path: String,
    output_path: String,
    start: String,
    end: String,
    video_codec: String,
    audio_codec: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertPayload {
    source_path: String,
    output_path: String,
    video_codec: String,
    audio_codec: String,
    video_bitrate: String,
    audio_bitrate: String,
}

fn format_output_path(input_path: &str, extension: &str, suffix: Option<&str>) -> Option<PathBuf> {
    let path = Path::new(input_path);
    let stem = path.file_stem()?.to_string_lossy();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let suffix = suffix.unwrap_or("_trim");
    Some(parent.join(format!("{}{}.{}", stem, suffix, extension)))
}

fn run_command(command: &str, args: &[String]) -> Result<CommandResult, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(CommandResult {
            command: std::iter::once(command.to_string())
                .chain(args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" "),
            log: if stderr.is_empty() { stdout } else { stderr },
        });
    }

    Err(String::from_utf8_lossy(&output.stderr).to_string())
}

#[tauri::command]
fn open_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Media files", &["mp4", "mkv", "mov", "avi", "mp3", "wav", "m4a", "flac", "webm"])
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_file(source_path: String, extension: String, suffix: Option<String>) -> Option<String> {
    let default_path = format_output_path(&source_path, &extension, suffix.as_deref())?;
    FileDialog::new()
        .add_filter(format!("{} file", extension.to_uppercase()), &[extension.as_str()])
        .set_file_name(default_path.file_name()?.to_string_lossy().as_ref())
        .set_directory(default_path.parent()?)
        .save_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn probe_media(file_path: String) -> Result<serde_json::Value, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        file_path,
    ];

    let result = run_command("ffprobe", &args)?;
    serde_json::from_str(&result.log).map_err(|error| error.to_string())
}

#[tauri::command]
fn run_lossless_cut(payload: LosslessCutPayload) -> Result<CommandResult, String> {
    let mut args = vec!["-y".to_string()];

    if !payload.start.is_empty() {
        args.push("-ss".to_string());
        args.push(payload.start);
    }

    if !payload.end.is_empty() {
        args.push("-to".to_string());
        args.push(payload.end);
    }

    args.extend([
        "-i".to_string(),
        payload.source_path,
        "-c:v".to_string(),
        payload.video_codec,
        "-c:a".to_string(),
        payload.audio_codec,
        payload.output_path,
    ]);

    run_command("ffmpeg", &args)
}

#[tauri::command]
fn run_convert(payload: ConvertPayload) -> Result<CommandResult, String> {
    let mut args = vec!["-y".to_string(), "-i".to_string(), payload.source_path];

    if payload.video_codec == "none" {
        args.push("-vn".to_string());
    } else {
        args.push("-c:v".to_string());
        args.push(payload.video_codec.clone());
        if !payload.video_bitrate.is_empty() && payload.video_codec != "copy" {
            args.push("-b:v".to_string());
            args.push(payload.video_bitrate);
        }
    }

    if payload.audio_codec == "none" {
        args.push("-an".to_string());
    } else {
        args.push("-c:a".to_string());
        args.push(payload.audio_codec.clone());
        if !payload.audio_bitrate.is_empty() && payload.audio_codec != "copy" {
            args.push("-b:a".to_string());
            args.push(payload.audio_bitrate);
        }
    }

    args.push(payload.output_path);
    run_command("ffmpeg", &args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_file, save_file, probe_media, run_lossless_cut, run_convert])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

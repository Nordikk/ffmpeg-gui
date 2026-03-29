use rfd::FileDialog;
use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{async_runtime, Builder};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    command: String,
    log: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryStatus {
    available: bool,
    version: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg: BinaryStatus,
    ffprobe: BinaryStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyframeProbe {
    keyframes: Vec<f64>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCommandResult {
    commands: Vec<String>,
    outputs: Vec<String>,
    log: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioExportPayload {
    source_path: String,
    output_path: String,
    audio_codec: String,
    audio_bitrate: String,
    sample_rate: String,
    channels: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameExportPayload {
    source_path: String,
    output_dir: String,
    image_format: String,
    fps: String,
    quality: String,
    start_number: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchConvertPayload {
    source_paths: Vec<String>,
    container: String,
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

fn shell_quote(value: &str) -> String {
    if value.contains(' ') || value.contains('"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn format_command_line(command: &Path, args: &[String]) -> String {
    std::iter::once(command.display().to_string())
        .chain(args.iter().map(|arg| shell_quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn fallback_search_dirs() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    }

    #[cfg(not(target_os = "macos"))]
    {
        &[]
    }
}

fn candidate_binary_names(binary: &str) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let has_extension = Path::new(binary)
            .extension()
            .and_then(|value| value.to_str())
            .is_some();

        if has_extension {
            vec![binary.to_string()]
        } else {
            vec![binary.to_string(), format!("{binary}.exe")]
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![binary.to_string()]
    }
}

fn resolve_binary(binary: &str) -> Result<PathBuf, String> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        if binary_path.exists() {
            return Ok(binary_path.to_path_buf());
        }

        return Err(format!("{binary} does not exist"));
    }

    let mut search_dirs = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    for fallback in fallback_search_dirs() {
        let fallback_path = PathBuf::from(fallback);
        if !search_dirs.iter().any(|entry| entry == &fallback_path) {
            search_dirs.push(fallback_path);
        }
    }

    let candidate_names = candidate_binary_names(binary);
    for directory in search_dirs {
        for candidate_name in &candidate_names {
            let candidate_path = directory.join(candidate_name);
            if candidate_path.is_file() {
                return Ok(candidate_path);
            }
        }
    }

    Err(format!(
        "{binary} was not found. Checked PATH and fallback directories: {}",
        fallback_search_dirs().join(", ")
    ))
}

fn build_convert_args(payload: &ConvertPayload) -> Vec<String> {
    let mut args = vec!["-y".to_string(), "-i".to_string(), payload.source_path.clone()];

    if payload.video_codec == "none" {
        args.push("-vn".to_string());
    } else {
        args.push("-c:v".to_string());
        args.push(payload.video_codec.clone());
        if !payload.video_bitrate.is_empty() && payload.video_codec != "copy" {
            args.push("-b:v".to_string());
            args.push(payload.video_bitrate.clone());
        }
    }

    if payload.audio_codec == "none" {
        args.push("-an".to_string());
    } else {
        args.push("-c:a".to_string());
        args.push(payload.audio_codec.clone());
        if !payload.audio_bitrate.is_empty() && payload.audio_codec != "copy" {
            args.push("-b:a".to_string());
            args.push(payload.audio_bitrate.clone());
        }
    }

    args.push(payload.output_path.clone());
    args
}

fn run_command(command: &str, args: &[String]) -> Result<CommandResult, String> {
    let resolved_command = resolve_binary(command)?;
    let command_line = format_command_line(&resolved_command, args);
    let output = Command::new(&resolved_command)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(CommandResult {
            command: command_line,
            log: if stderr.is_empty() { stdout } else { stderr },
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{command} exited with status {}", output.status)
    };

    Err(format!("Command: {command_line}\n\n{details}"))
}

fn probe_binary(binary: &str) -> BinaryStatus {
    let resolved_binary = match resolve_binary(binary) {
        Ok(value) => value,
        Err(error) => {
            return BinaryStatus {
                available: false,
                version: String::new(),
                error,
            }
        }
    };

    match Command::new(&resolved_binary).arg("-version").output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            let version = text.lines().next().unwrap_or_default().trim().to_string();
            BinaryStatus {
                available: true,
                version: format!("{} ({})", version, resolved_binary.display()),
                error: String::new(),
            }
        }
        Ok(output) => BinaryStatus {
            available: false,
            version: String::new(),
            error: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(error) => BinaryStatus {
            available: false,
            version: String::new(),
            error: error.to_string(),
        },
    }
}

#[tauri::command]
async fn check_tool_status() -> ToolStatus {
    let ffmpeg_task = async_runtime::spawn_blocking(|| probe_binary("ffmpeg"));
    let ffprobe_task = async_runtime::spawn_blocking(|| probe_binary("ffprobe"));

    ToolStatus {
        ffmpeg: ffmpeg_task.await.unwrap_or_else(|error| BinaryStatus {
            available: false,
            version: String::new(),
            error: error.to_string(),
        }),
        ffprobe: ffprobe_task.await.unwrap_or_else(|error| BinaryStatus {
            available: false,
            version: String::new(),
            error: error.to_string(),
        }),
    }
}

#[tauri::command]
fn open_file() -> Option<String> {
    FileDialog::new()
        .add_filter(
            "Media files",
            &["mp4", "mkv", "mov", "avi", "mp3", "wav", "m4a", "flac", "webm"],
        )
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_files() -> Vec<String> {
    FileDialog::new()
        .add_filter(
            "Media files",
            &["mp4", "mkv", "mov", "avi", "mp3", "wav", "m4a", "flac", "webm"],
        )
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_file(source_path: String, extension: String, suffix: Option<String>) -> Option<String> {
    let default_path = format_output_path(&source_path, &extension, suffix.as_deref())?;
    FileDialog::new()
        .add_filter(
            format!("{} file", extension.to_uppercase()),
            &[extension.as_str()],
        )
        .set_file_name(default_path.file_name()?.to_string_lossy().as_ref())
        .set_directory(default_path.parent()?)
        .save_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn probe_media(file_path: String) -> Result<serde_json::Value, String> {
    let result = async_runtime::spawn_blocking(move || {
        let args = vec![
            "-v".to_string(),
            "error".to_string(),
            "-print_format".to_string(),
            "json".to_string(),
            "-show_format".to_string(),
            "-show_streams".to_string(),
            file_path,
        ];

        run_command("ffprobe", &args)
    })
    .await
    .map_err(|error| error.to_string())??;

    serde_json::from_str(&result.log).map_err(|error| error.to_string())
}

#[tauri::command]
async fn probe_keyframes(file_path: String) -> Result<KeyframeProbe, String> {
    let result = async_runtime::spawn_blocking(move || {
        let args = vec![
            "-v".to_string(),
            "error".to_string(),
            "-skip_frame".to_string(),
            "nokey".to_string(),
            "-select_streams".to_string(),
            "v:0".to_string(),
            "-show_entries".to_string(),
            "frame=pts_time".to_string(),
            "-of".to_string(),
            "csv=p=0".to_string(),
            file_path,
        ];

        run_command("ffprobe", &args)
    })
    .await
    .map_err(|error| error.to_string())??;

    let keyframes = result
        .log
        .lines()
        .filter_map(|line| line.trim().parse::<f64>().ok())
        .take(10_000)
        .collect::<Vec<_>>();

    Ok(KeyframeProbe { keyframes })
}

#[tauri::command]
async fn run_lossless_cut(payload: LosslessCutPayload) -> Result<CommandResult, String> {
    async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_convert(payload: ConvertPayload) -> Result<CommandResult, String> {
    async_runtime::spawn_blocking(move || run_command("ffmpeg", &build_convert_args(&payload)))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_audio_export(payload: AudioExportPayload) -> Result<CommandResult, String> {
    async_runtime::spawn_blocking(move || {
        let mut args = vec![
            "-y".to_string(),
            "-i".to_string(),
            payload.source_path,
            "-vn".to_string(),
            "-c:a".to_string(),
            payload.audio_codec.clone(),
        ];

        if !payload.audio_bitrate.is_empty() && payload.audio_codec != "copy" {
            args.push("-b:a".to_string());
            args.push(payload.audio_bitrate);
        }

        if !payload.sample_rate.is_empty() {
            args.push("-ar".to_string());
            args.push(payload.sample_rate);
        }

        if !payload.channels.is_empty() {
            args.push("-ac".to_string());
            args.push(payload.channels);
        }

        args.push(payload.output_path);
        run_command("ffmpeg", &args)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_frame_export(payload: FrameExportPayload) -> Result<CommandResult, String> {
    async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&payload.output_dir).map_err(|error| error.to_string())?;

        let output_pattern = Path::new(&payload.output_dir)
            .join(format!("frame_%06d.{}", payload.image_format))
            .to_string_lossy()
            .to_string();

        let mut args = vec!["-y".to_string(), "-i".to_string(), payload.source_path];

        if !payload.fps.is_empty() {
            args.push("-vf".to_string());
            args.push(format!("fps={}", payload.fps));
        }

        args.push("-start_number".to_string());
        args.push(payload.start_number.to_string());

        if !payload.quality.is_empty() && matches!(payload.image_format.as_str(), "jpg" | "jpeg" | "webp") {
            args.push("-q:v".to_string());
            args.push(payload.quality);
        }

        args.push(output_pattern);
        run_command("ffmpeg", &args)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_batch_convert(payload: BatchConvertPayload) -> Result<BatchCommandResult, String> {
    async_runtime::spawn_blocking(move || {
        if payload.source_paths.is_empty() {
            return Err("No files selected".to_string());
        }

        let mut commands = Vec::new();
        let mut outputs = Vec::new();
        let mut logs = Vec::new();

        for source_path in payload.source_paths {
            let output_path = format_output_path(&source_path, &payload.container, Some("_batch_convert"))
                .ok_or_else(|| format!("Could not determine output path for {}", source_path))?
                .to_string_lossy()
                .to_string();

            let result = run_command(
                "ffmpeg",
                &build_convert_args(&ConvertPayload {
                    source_path: source_path.clone(),
                    output_path: output_path.clone(),
                    video_codec: payload.video_codec.clone(),
                    audio_codec: payload.audio_codec.clone(),
                    video_bitrate: payload.video_bitrate.clone(),
                    audio_bitrate: payload.audio_bitrate.clone(),
                }),
            )?;

            commands.push(result.command);
            outputs.push(output_path.clone());
            logs.push(format!("{}\n{}", output_path, result.log));
        }

        Ok(BatchCommandResult {
            commands,
            outputs,
            log: logs.join("\n\n"),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_tool_status,
            open_file,
            open_files,
            pick_folder,
            save_file,
            probe_media,
            probe_keyframes,
            run_lossless_cut,
            run_convert,
            run_audio_export,
            run_frame_export,
            run_batch_convert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

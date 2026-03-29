use rfd::FileDialog;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::{
    cell::UnsafeCell,
    collections::HashSet,
    ffi::OsString,
    os::{raw::c_void, windows::ffi::OsStringExt},
    path::PathBuf as WindowsPathBuf,
    ptr,
    rc::Rc,
    sync::{Mutex, OnceLock},
};

#[cfg(windows)]
use windows::{
    core::{implement, BOOL},
    Win32::{
        Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{CoInitializeEx, IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL, COINIT_APARTMENTTHREADED},
            Ole::{
                IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP,
                DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Shell::{DragFinish, DragQueryFileW, HDROP},
            WindowsAndMessaging::EnumChildWindows,
        },
    },
};

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropPosition {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDropPayload {
    kind: String,
    paths: Vec<String>,
    position: Option<DropPosition>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDropStatusPayload {
    registered_windows: usize,
    detail: String,
}

#[cfg(windows)]
enum NativeWindowsDragDropEvent {
    Enter {
        paths: Vec<WindowsPathBuf>,
        position: (i32, i32),
    },
    Over {
        position: (i32, i32),
    },
    Drop {
        paths: Vec<WindowsPathBuf>,
        position: (i32, i32),
    },
    Leave,
}

#[cfg(windows)]
#[derive(Default)]
struct WindowsOleDropController {
    drop_targets: Vec<IDropTarget>,
    registered_windows: usize,
}

#[cfg(windows)]
impl WindowsOleDropController {
    fn new(hwnd: HWND, handler: Rc<dyn Fn(NativeWindowsDragDropEvent)>) -> Self {
        let mut controller = Self::default();
        let mut callback = |child_hwnd| controller.inject_in_hwnd(child_hwnd, handler.clone());
        let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
        let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
        let lparam = LPARAM(closure_pointer_pointer as isize);

        unsafe extern "system" fn enumerate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let closure = unsafe {
                &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool)
            };
            closure(hwnd).into()
        }

        let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enumerate_callback), lparam) };
        controller
    }

    fn inject_in_hwnd(&mut self, hwnd: HWND, handler: Rc<dyn Fn(NativeWindowsDragDropEvent)>) -> bool {
        let drag_drop_target: IDropTarget = WindowsOleDropTarget::new(hwnd, handler).into();
        if unsafe { RevokeDragDrop(hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into())
            && unsafe { RegisterDragDrop(hwnd, &drag_drop_target) }.is_ok()
        {
            self.drop_targets.push(drag_drop_target);
            self.registered_windows += 1;
        }

        true
    }
}

#[cfg(windows)]
#[implement(IDropTarget)]
struct WindowsOleDropTarget {
    hwnd: HWND,
    listener: Rc<dyn Fn(NativeWindowsDragDropEvent)>,
    cursor_effect: UnsafeCell<DROPEFFECT>,
    enter_is_valid: UnsafeCell<bool>,
}

#[cfg(windows)]
impl WindowsOleDropTarget {
    fn new(hwnd: HWND, listener: Rc<dyn Fn(NativeWindowsDragDropEvent)>) -> Self {
        Self {
            hwnd,
            listener,
            cursor_effect: DROPEFFECT_NONE.into(),
            enter_is_valid: false.into(),
        }
    }

    unsafe fn iterate_filenames<F>(
        data_obj: windows_core::Ref<'_, IDataObject>,
        mut callback: F,
    ) -> Option<HDROP>
    where
        F: FnMut(WindowsPathBuf),
    {
        let drop_format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };

        match data_obj
            .as_ref()
            .expect("Received null IDataObject")
            .GetData(&drop_format)
        {
            Ok(medium) => {
                let hdrop = HDROP(medium.u.hGlobal.0 as _);
                let item_count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);

                for index in 0..item_count {
                    let character_count = DragQueryFileW(hdrop, index, None) as usize;
                    let mut path_buf = vec![0; character_count + 1];
                    DragQueryFileW(hdrop, index, Some(&mut path_buf));
                    callback(OsString::from_wide(&path_buf[..character_count]).into());
                }

                Some(hdrop)
            }
            Err(_) => None,
        }
    }
}

#[cfg(windows)]
#[allow(non_snake_case)]
impl IDropTarget_Impl for WindowsOleDropTarget_Impl {
    fn DragEnter(
        &self,
        pDataObj: windows_core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let mut local_point = POINT { x: pt.x, y: pt.y };
        let _ = unsafe { ScreenToClient(self.hwnd, &mut local_point) };

        let mut paths = Vec::new();
        let hdrop = unsafe { WindowsOleDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };
        let enter_is_valid = hdrop.is_some();

        unsafe {
            *self.enter_is_valid.get() = enter_is_valid;
        }

        let cursor_effect = if enter_is_valid {
            DROPEFFECT_COPY
        } else {
            DROPEFFECT_NONE
        };

        unsafe {
            *pdwEffect = cursor_effect;
            *self.cursor_effect.get() = cursor_effect;
        }

        if enter_is_valid {
            (self.listener)(NativeWindowsDragDropEvent::Enter {
                paths,
                position: (local_point.x, local_point.y),
            });
        }

        Ok(())
    }

    fn DragOver(
        &self,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if unsafe { *self.enter_is_valid.get() } {
            let mut local_point = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.hwnd, &mut local_point) };
            (self.listener)(NativeWindowsDragDropEvent::Over {
                position: (local_point.x, local_point.y),
            });
        }

        unsafe {
            *pdwEffect = *self.cursor_effect.get();
        }

        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if unsafe { *self.enter_is_valid.get() } {
            (self.listener)(NativeWindowsDragDropEvent::Leave);
        }

        Ok(())
    }

    fn Drop(
        &self,
        pDataObj: windows_core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        _pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if unsafe { *self.enter_is_valid.get() } {
            let mut local_point = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.hwnd, &mut local_point) };

            let mut paths = Vec::new();
            let hdrop = unsafe { WindowsOleDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };
            (self.listener)(NativeWindowsDragDropEvent::Drop {
                paths,
                position: (local_point.x, local_point.y),
            });

            if let Some(hdrop) = hdrop {
                unsafe {
                    DragFinish(hdrop);
                }
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
fn emit_native_file_drop_status<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    window_label: &str,
    registered_windows: usize,
    detail: impl Into<String>,
) {
    let _ = app_handle.emit_to(
        window_label,
        "native-file-drop-status",
        NativeFileDropStatusPayload {
            registered_windows,
            detail: detail.into(),
        },
    );
}

#[cfg(windows)]
fn install_windows_file_drop_fallback<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> tauri::Result<()> {
    static INSTALLED_WEBVIEWS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

    let window = webview.window();
    let hwnd = window.hwnd()?;
    let app_handle = webview.app_handle().clone();
    let window_label = webview.label().to_string();

    {
        let installed = INSTALLED_WEBVIEWS.get_or_init(|| Mutex::new(HashSet::new()));
        let installed = installed.lock().expect("failed to lock native drop install state");
        if installed.contains(&window_label) {
            emit_native_file_drop_status(&app_handle, &window_label, 0, "Native Windows drop bridge already installed.");
            return Ok(());
        }
    }

    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let event_app_handle = app_handle.clone();
    let event_window_label = window_label.clone();

    let listener: Rc<dyn Fn(NativeWindowsDragDropEvent)> = Rc::new(move |event| {
        let payload = match event {
            NativeWindowsDragDropEvent::Enter { paths, position } => NativeFileDropPayload {
                kind: "enter".to_string(),
                paths: paths
                    .iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect(),
                position: Some(DropPosition {
                    x: position.0 as f64,
                    y: position.1 as f64,
                }),
            },
            NativeWindowsDragDropEvent::Over { position } => NativeFileDropPayload {
                kind: "over".to_string(),
                paths: Vec::new(),
                position: Some(DropPosition {
                    x: position.0 as f64,
                    y: position.1 as f64,
                }),
            },
            NativeWindowsDragDropEvent::Drop { paths, position } => NativeFileDropPayload {
                kind: "drop".to_string(),
                paths: paths
                    .iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect(),
                position: Some(DropPosition {
                    x: position.0 as f64,
                    y: position.1 as f64,
                }),
            },
            NativeWindowsDragDropEvent::Leave => NativeFileDropPayload {
                kind: "leave".to_string(),
                paths: Vec::new(),
                position: None,
            },
        };

        let _ = event_app_handle.emit_to(event_window_label.as_str(), "native-file-drop", payload);
    });

    let controller = WindowsOleDropController::new(hwnd, listener);
    let registered_windows = controller.registered_windows;

    if registered_windows == 0 {
        emit_native_file_drop_status(
            &app_handle,
            &window_label,
            0,
            "Native Windows drop bridge did not find any WebView child windows to register.",
        );
        return Ok(());
    }

    {
        let installed = INSTALLED_WEBVIEWS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut installed = installed.lock().expect("failed to lock native drop install state");
        installed.insert(window_label.clone());
    }

    let _ = Box::leak(Box::new(controller));
    emit_native_file_drop_status(
        &app_handle,
        &window_label,
        registered_windows,
        format!("Native Windows drop bridge installed on {registered_windows} WebView window(s)."),
    );
    Ok(())
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

fn shell_quote(value: &str) -> String {
    if value.contains(' ') || value.contains('"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
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
                .chain(args.iter().map(|arg| shell_quote(arg)))
                .collect::<Vec<_>>()
                .join(" "),
            log: if stderr.is_empty() { stdout } else { stderr },
        });
    }

    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

fn probe_binary(binary: &str) -> BinaryStatus {
    match Command::new(binary).arg("-version").output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            let version = text.lines().next().unwrap_or_default().trim().to_string();
            BinaryStatus {
                available: true,
                version,
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
fn check_tool_status() -> ToolStatus {
    ToolStatus {
        ffmpeg: probe_binary("ffmpeg"),
        ffprobe: probe_binary("ffprobe"),
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
fn probe_keyframes(file_path: String) -> Result<KeyframeProbe, String> {
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

    let result = run_command("ffprobe", &args)?;
    let keyframes = result
        .log
        .lines()
        .filter_map(|line| line.trim().parse::<f64>().ok())
        .take(10_000)
        .collect::<Vec<_>>();

    Ok(KeyframeProbe { keyframes })
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
        .on_page_load(|webview, _| {
            #[cfg(windows)]
            {
                let webview = webview.clone();
                let install_webview = webview.clone();
                let _ = webview.run_on_main_thread(move || {
                    let _ = install_windows_file_drop_fallback(&install_webview);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_tool_status,
            open_file,
            save_file,
            probe_media,
            probe_keyframes,
            run_lossless_cut,
            run_convert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, Runtime, WebviewWindow, Window};

const FILE_NAME: &str = "window.json";
const MIN_WIDTH: f64 = 400.0;
const MIN_HEIGHT: f64 = 280.0;
const MAX_SIZE: f64 = 8000.0;
const WRITE_INTERVAL: Duration = Duration::from_millis(800);

#[derive(Serialize, Deserialize)]
struct WindowSize {
    width: f64,
    height: f64,
}

static PENDING: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(false);

pub fn restore(window: &WebviewWindow<impl Runtime>) {
    let Some((mut width, mut height)) = read(window.app_handle()) else {
        return;
    };
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
        width = width.min(logical.width);
        height = height.min(logical.height);
    }
    if let Some((width, height)) = clamp_size(width, height) {
        let _ = window.set_size(LogicalSize::new(width, height));
    }
}

pub fn remember(window: &Window<impl Runtime>) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    let Some((width, height)) = clamp_size(logical.width, logical.height) else {
        return;
    };
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some((width, height));
        DIRTY.store(true, Ordering::Relaxed);
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WRITE_INTERVAL);
        if !DIRTY.swap(false, Ordering::Relaxed) {
            continue;
        }
        let size = PENDING.lock().ok().and_then(|pending| *pending);
        if let Some((width, height)) = size {
            write(&app, width, height);
        }
    });
}

pub fn flush(app: &AppHandle) {
    if !DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let size = PENDING.lock().ok().and_then(|pending| *pending);
    if let Some((width, height)) = size {
        write(app, width, height);
    }
}

fn storage_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    let raw = fs::read_to_string(storage_path(app)?).ok()?;
    let parsed: WindowSize = serde_json::from_str(&raw).ok()?;
    clamp_size(parsed.width, parsed.height)
}

fn write<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let Some(path) = storage_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&WindowSize { width, height }) {
        let _ = fs::write(path, json);
    }
}

fn clamp_size(width: f64, height: f64) -> Option<(f64, f64)> {
    if !width.is_finite() || !height.is_finite() {
        return None;
    }
    Some((
        width.clamp(MIN_WIDTH, MAX_SIZE),
        height.clamp(MIN_HEIGHT, MAX_SIZE),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_below_minimum() {
        assert_eq!(clamp_size(10.0, 10.0), Some((MIN_WIDTH, MIN_HEIGHT)));
    }

    #[test]
    fn clamps_above_maximum() {
        assert_eq!(clamp_size(99_999.0, 99_999.0), Some((MAX_SIZE, MAX_SIZE)));
    }

    #[test]
    fn rejects_invalid_sizes() {
        assert_eq!(clamp_size(f64::NAN, 400.0), None);
        assert_eq!(clamp_size(400.0, f64::INFINITY), None);
    }

    #[test]
    fn keeps_valid_sizes() {
        assert_eq!(clamp_size(620.0, 400.0), Some((620.0, 400.0)));
    }
}

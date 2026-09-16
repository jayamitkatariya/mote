use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Window};

const FILE_NAME: &str = "pins.json";
const WRITE_INTERVAL: Duration = Duration::from_millis(600);
const MIN_WIDTH: f64 = 180.0;
const MIN_HEIGHT: f64 = 120.0;
const MAX_SIZE: f64 = 8000.0;
const MIN_VISIBLE: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

static STATE: Mutex<Option<HashMap<String, PinRect>>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(false);
static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn storage_path() -> Option<PathBuf> {
    DIR.lock().ok().and_then(|dir| dir.clone()).map(|dir| dir.join(FILE_NAME))
}

fn read_file() -> HashMap<String, PinRect> {
    let Some(path) = storage_path() else {
        return HashMap::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn with_state<T>(f: impl FnOnce(&mut HashMap<String, PinRect>) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(read_file());
    }
    f(guard.as_mut().expect("state initialized"))
}

pub fn start(app: AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(mut slot) = DIR.lock() {
            *slot = Some(dir);
        }
    }
    with_state(|_| ());
    std::thread::spawn(move || loop {
        std::thread::sleep(WRITE_INTERVAL);
        if !DIRTY.swap(false, Ordering::Relaxed) {
            continue;
        }
        let snapshot = with_state(|state| state.clone());
        write_file(&snapshot);
    });
}

fn write_file(state: &HashMap<String, PinRect>) {
    let Some(path) = storage_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(state) {
        let _ = fs::write(path, json);
    }
}

pub fn get(id: &str) -> Option<PinRect> {
    with_state(|state| state.get(id).copied())
}

pub fn forget(app: &AppHandle<impl Runtime>, id: &str) {
    let snapshot = with_state(|state| {
        state.remove(id);
        state.clone()
    });
    DIRTY.store(false, Ordering::Relaxed);
    write_file(&snapshot);
    let _ = app;
}

pub fn remember<R: Runtime>(window: &Window<R>) {
    let Some(id) = window.label().strip_prefix("pin-") else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let rect = logical_rect(position, size, scale);
    with_state(|state| {
        state.insert(id.to_string(), rect);
    });
    DIRTY.store(true, Ordering::Relaxed);
}

fn logical_rect(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> PinRect {
    let x = position.x as f64 / scale;
    let y = position.y as f64 / scale;
    let width = (size.width as f64 / scale).clamp(MIN_WIDTH, MAX_SIZE);
    let height = (size.height as f64 / scale).clamp(MIN_HEIGHT, MAX_SIZE);
    PinRect {
        x,
        y,
        width,
        height,
    }
}

pub fn flush(app: &AppHandle<impl Runtime>) {
    if !DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let snapshot = with_state(|state| state.clone());
    write_file(&snapshot);
    let _ = app;
}

pub fn on_screen(app: &AppHandle<impl Runtime>, rect: &PinRect) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let area = monitor.size().to_logical::<f64>(scale);
        overlaps_monitor(rect, origin.x, origin.y, area.width, area.height)
    })
}

fn overlaps_monitor(rect: &PinRect, mx: f64, my: f64, mw: f64, mh: f64) -> bool {
    let right = rect.x + rect.width.max(MIN_VISIBLE);
    let bottom = rect.y + rect.height.max(MIN_VISIBLE);
    rect.x < mx + mw - MIN_VISIBLE
        && right > mx + MIN_VISIBLE
        && rect.y < my + mh - MIN_VISIBLE
        && bottom > my + MIN_VISIBLE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64) -> PinRect {
        PinRect {
            x,
            y,
            width: 280.0,
            height: 240.0,
        }
    }

    #[test]
    fn clamps_tiny_windows_to_minimum() {
        let logical = logical_rect(
            PhysicalPosition::new(10, 20),
            PhysicalSize::new(10, 10),
            1.0,
        );
        assert_eq!(logical.width, MIN_WIDTH);
        assert_eq!(logical.height, MIN_HEIGHT);
    }

    #[test]
    fn converts_physical_to_logical() {
        let logical = logical_rect(
            PhysicalPosition::new(200, 400),
            PhysicalSize::new(560, 480),
            2.0,
        );
        assert_eq!(logical, PinRect { x: 100.0, y: 200.0, width: 280.0, height: 240.0 });
    }

    #[test]
    fn visible_rect_requires_overlap() {
        assert!(overlaps_monitor(&rect(100.0, 100.0), 0.0, 0.0, 1440.0, 900.0));
        assert!(!overlaps_monitor(&rect(-400.0, 100.0), 0.0, 0.0, 1440.0, 900.0));
        assert!(!overlaps_monitor(&rect(2000.0, 100.0), 0.0, 0.0, 1440.0, 900.0));
        assert!(overlaps_monitor(&rect(3000.0, 100.0), 2560.0, 0.0, 1920.0, 1080.0));
    }
}

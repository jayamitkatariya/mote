mod shake;
mod window_state;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartManager;

static HIDE_ON_BLUR: AtomicBool = AtomicBool::new(true);
static HAS_SHOWN: AtomicBool = AtomicBool::new(false);
static FOCUSED_SINCE_REVEAL: AtomicBool = AtomicBool::new(false);
static LAST_REVEAL: Mutex<Option<Instant>> = Mutex::new(None);

/// Blur events fired right after a reveal are spurious while AppKit settles focus.
const BLUR_GRACE: Duration = Duration::from_millis(450);

const PIN_WIDTH: f64 = 280.0;
const PIN_HEIGHT: f64 = 240.0;

struct AutostartToggle(CheckMenuItem<tauri::Wry>);

#[tauri::command]
fn show_window(app: AppHandle) {
    reveal(&app);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    conceal(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

#[tauri::command]
fn exit_now(app: AppHandle) {
    app.exit(0);
}

fn request_quit(app: &AppHandle) {
    let _ = app.emit("mote://quit-requested", ());
    let fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        fallback.exit(0);
    });
}

#[tauri::command]
fn set_shake_enabled(enabled: bool) {
    shake::set_enabled(enabled);
}

#[tauri::command]
fn set_shake_sensitivity(value: u8) {
    shake::set_sensitivity(value);
}

#[tauri::command]
fn set_hide_on_blur(enabled: bool) {
    HIDE_ON_BLUR.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_pointer_down(down: bool) {
    shake::set_pointer_down(down);
}

#[tauri::command]
fn pin_note(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let label = format!("pin-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let index = app
        .webview_windows()
        .keys()
        .filter(|key| key.starts_with("pin-"))
        .count();
    let (x, y) = cascade_position(&app, index);

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("sticky.html".into()))
        .title(&title)
        .inner_size(PIN_WIDTH, PIN_HEIGHT)
        .min_inner_size(180.0, 120.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .position(x, y);

    #[cfg(target_os = "macos")]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![tauri::utils::WindowEffect::HudWindow],
        state: Some(tauri::utils::WindowEffectState::Active),
        radius: Some(18.0),
        color: None,
    });

    let window = builder.build().map_err(|error| error.to_string())?;
    apply_panel_behavior(&window);
    Ok(())
}

#[tauri::command]
fn unpin_note(app: AppHandle, id: String) {
    if let Some(window) = app.get_webview_window(&format!("pin-{id}")) {
        let _ = window.close();
    }
}

fn cascade_position(app: &AppHandle, index: usize) -> (f64, f64) {
    let Some((cursor_x, cursor_y)) = shake::cursor_position() else {
        let fallback = 140.0 + (index % 6) as f64 * 22.0;
        return (fallback, fallback);
    };
    let offset = 18.0 + (index % 6) as f64 * 20.0;

    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.monitor_from_point(cursor_x, cursor_y) {
            let scale = monitor.scale_factor();
            let origin = monitor.position().to_logical::<f64>(scale);
            let area = monitor.size().to_logical::<f64>(scale);
            let margin = 8.0;
            let min_x = origin.x + margin;
            let min_y = origin.y + margin;
            let max_x = origin.x + area.width - PIN_WIDTH - margin;
            let max_y = origin.y + area.height - PIN_HEIGHT - margin;
            let x = (cursor_x + offset).min(max_x).max(min_x);
            let y = (cursor_y + offset).min(max_y).max(min_y);
            return (x, y);
        }
    }

    (cursor_x + offset, cursor_y + offset)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| error.to_string())?;
    if let Some(toggle) = app.try_state::<AutostartToggle>() {
        let _ = toggle.0.set_checked(enabled);
    }
    Ok(())
}

pub(crate) fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        conceal(app);
    } else {
        reveal(app);
    }
}

pub(crate) fn reveal(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    FOCUSED_SINCE_REVEAL.store(false, Ordering::Relaxed);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_always_on_top(true);
    position_at_cursor(&window);
    apply_panel_behavior(&window);
    if let Ok(mut last) = LAST_REVEAL.lock() {
        *last = Some(Instant::now());
    }
    let _ = window.show();
    let _ = window.set_focus();
    HAS_SHOWN.store(true, Ordering::Relaxed);
    let _ = app.emit("mote://shown", ());
}

fn conceal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn revealed_recently() -> bool {
    LAST_REVEAL
        .lock()
        .ok()
        .and_then(|last| *last)
        .is_some_and(|instant| instant.elapsed() < BLUR_GRACE)
}

fn position_at_cursor(window: &WebviewWindow) {
    let monitor = shake::cursor_position()
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let origin = monitor.position();
    let area = monitor.size();
    let x = origin.x + (area.width as i32 - size.width as i32) / 2;
    let y = origin.y + ((area.height as i32 - size.height as i32) as f64 * 0.38) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(target_os = "macos")]
fn apply_panel_behavior(window: &WebviewWindow) {
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let Ok(handle) = window.ns_window() else {
        return;
    };
    let address = handle as usize;
    let window = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let panel = address as *mut NSWindow;
        if panel.is_null() {
            return;
        }
        let panel = &*panel;
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.setLevel(NSStatusWindowLevel);
        panel.setHidesOnDeactivate(false);
        panel.orderFrontRegardless();
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_panel_behavior(_window: &WebviewWindow) {}

fn rounded_rect_distance(
    px: f64,
    py: f64,
    cx: f64,
    cy: f64,
    half_w: f64,
    half_h: f64,
    radius: f64,
) -> f64 {
    let qx = (px - cx).abs() - (half_w - radius);
    let qy = (py - cy).abs() - (half_h - radius);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

fn segment_distance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared == 0.0 {
        0.0
    } else {
        (((px - ax) * dx + (py - ay) * dy) / length_squared).clamp(0.0, 1.0)
    };
    let qx = px - (ax + t * dx);
    let qy = py - (ay + t * dy);
    (qx * qx + qy * qy).sqrt()
}

fn coverage(distance: f64) -> f64 {
    (0.9 - distance).clamp(0.0, 1.0)
}

fn tray_icon() -> Image<'static> {
    const SIZE: u32 = 44;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];
    let center = SIZE as f64 / 2.0;
    let half_w = 12.0;
    let half_h = 15.0;
    let stroke = 2.4;
    let line_half = 6.6;
    let line_thickness = 1.7;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;

            let outline = rounded_rect_distance(px, py, center, center, half_w, half_h, 3.6).abs()
                - stroke / 2.0;
            let line_top = segment_distance(
                px,
                py,
                center - line_half,
                center - 4.2,
                center + line_half,
                center - 4.2,
            ) - line_thickness;
            let line_bottom = segment_distance(
                px,
                py,
                center - line_half,
                center + 3.4,
                center + line_half,
                center + 3.4,
            ) - line_thickness;

            let alpha = coverage(outline)
                .max(coverage(line_top))
                .max(coverage(line_bottom));
            let index = ((y * SIZE + x) * 4) as usize;
            rgba[index + 3] = (alpha * 255.0).round() as u8;
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open Mote", true, Some("Alt+M"))?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "Open at Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Mote", true, Some("Cmd+Q"))?;
    let menu = Menu::with_items(app, &[&open_item, &autostart_item, &separator, &quit_item])?;
    let autostart_handle = autostart_item.clone();
    app.manage(AutostartToggle(autostart_item.clone()));

    let builder = TrayIconBuilder::with_id("mote")
        .icon(tray_icon())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => reveal(app),
            "autostart" => {
                let manager = app.autolaunch();
                let next = !manager.is_enabled().unwrap_or(false);
                let result = if next {
                    manager.enable()
                } else {
                    manager.disable()
                };
                if result.is_ok() {
                    let _ = autostart_handle.set_checked(next);
                }
            }
            "quit" => request_quit(app),
            _ => {}
        });

    builder.build(app)?;
    Ok(())
}

fn register_shortcut(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let toggle_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyM);
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state() == ShortcutState::Pressed && shortcut == &toggle_shortcut {
                    toggle(app);
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(toggle_shortcut)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            show_window,
            hide_window,
            quit_app,
            exit_now,
            set_shake_enabled,
            set_shake_sensitivity,
            set_hide_on_blur,
            get_autostart,
            set_autostart,
            set_pointer_down,
            pin_note,
            unpin_note
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;
            if let Err(error) = register_shortcut(app.handle()) {
                eprintln!("mote: could not register the global shortcut: {error}");
            }
            shake::start(app.handle().clone());
            window_state::start(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                window_state::restore(&window);

                #[cfg(debug_assertions)]
                {
                    let _ = window.show();
                    let _ = window.set_focus();
                    HAS_SHOWN.store(true, Ordering::Relaxed);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Resized(_) => {
                if window.label() == "main" {
                    window_state::remember(window);
                }
            }
            WindowEvent::Destroyed => {
                if let Some(note_id) = window.label().strip_prefix("pin-") {
                    let _ = window
                        .app_handle()
                        .emit("mote://pin-closed", note_id.to_string());
                }
            }
            WindowEvent::Focused(true) => {
                if window.label() == "main" {
                    FOCUSED_SINCE_REVEAL.store(true, Ordering::Relaxed);
                }
            }
            WindowEvent::Focused(false)
                if window.label() == "main"
                    && HIDE_ON_BLUR.load(Ordering::Relaxed)
                    && HAS_SHOWN.load(Ordering::Relaxed)
                    && FOCUSED_SINCE_REVEAL.load(Ordering::Relaxed)
                    && !revealed_recently() =>
            {
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                window_state::flush(app);
            }
        });
}

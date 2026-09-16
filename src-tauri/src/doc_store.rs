use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

/// Development builds keep their own document so hot-reload can never touch the
/// notes owned by the release app.
#[cfg(debug_assertions)]
pub const DOC_FILE: &str = "doc.dev.json";
#[cfg(not(debug_assertions))]
pub const DOC_FILE: &str = "doc.json";
pub const BACKUP_DIR: &str = "backups";
const MAX_BACKUPS: usize = 10;
const BACKUP_INTERVAL: Duration = Duration::from_secs(600);

static LAST_BACKUP: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct MarkdownFile {
    pub name: String,
    pub contents: String,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| error.to_string())
}

fn doc_path(dir: &Path) -> PathBuf {
    dir.join(DOC_FILE)
}

fn stem() -> &'static str {
    DOC_FILE.strip_suffix(".json").unwrap_or(DOC_FILE)
}

fn backup_dir(dir: &Path) -> PathBuf {
    dir.join(BACKUP_DIR)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("doc");
    let tmp = parent.join(format!(".{file_name}.{}.tmp", now_millis()));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Ok(handle) = fs::File::open(parent) {
        let _ = handle.sync_all();
    }
    Ok(())
}

fn quarantine(dir: &Path, path: &Path) -> Option<PathBuf> {
    let target = backup_dir(dir).join(format!("{}-corrupt-{}.json", stem(), now_millis()));
    fs::create_dir_all(target.parent()?).ok()?;
    fs::rename(path, &target).ok()?;
    Some(target)
}

fn read_doc(dir: &Path) -> Option<Value> {
    let path = doc_path(dir);
    let raw = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if is_doc_shape(&value) => Some(value),
        _ => {
            if let Some(target) = quarantine(dir, &path) {
                eprintln!("mote: quarantined unreadable doc to {}", target.display());
            }
            None
        }
    }
}

fn is_doc_shape(value: &Value) -> bool {
    value.is_object()
        && value
            .get("notes")
            .map(|notes| notes.is_array())
            .unwrap_or(false)
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Value>, String> {
    let dir = data_dir(app)?;
    Ok(read_doc(&dir))
}

pub fn save<R: Runtime>(app: &AppHandle<R>, doc: &Value) -> Result<(), String> {
    if !is_doc_shape(doc) {
        return Err("refusing to save a document without a notes array".into());
    }
    let dir = data_dir(app)?;
    backup_if_stale(&dir);
    atomic_write(&doc_path(&dir), doc.to_string().as_bytes()).map_err(|error| error.to_string())
}

pub fn get_note<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<Value>, String> {
    let Some(doc) = load(app)? else {
        return Ok(None);
    };
    Ok(doc
        .get("notes")
        .and_then(Value::as_array)
        .and_then(|notes| {
            notes
                .iter()
                .find(|note| note.get("id").and_then(Value::as_str) == Some(id))
                .cloned()
        }))
}

fn backup_if_stale(dir: &Path) {
    let Ok(mut last) = LAST_BACKUP.lock() else {
        return;
    };
    let stale = last.is_none_or(|instant| instant.elapsed() >= BACKUP_INTERVAL);
    if !stale {
        return;
    }
    if backup_current(dir) {
        *last = Some(Instant::now());
    }
}

pub fn backup_on_launch<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(dir) = data_dir(app) {
        if backup_current(&dir) {
            if let Ok(mut last) = LAST_BACKUP.lock() {
                *last = Some(Instant::now());
            }
        }
    }
}

fn backup_current(dir: &Path) -> bool {
    let path = doc_path(dir);
    if !path.is_file() {
        return false;
    }
    let target = backup_dir(dir).join(format!("{}-{}.json", stem(), now_millis()));
    if fs::create_dir_all(target.parent().unwrap_or(dir)).is_err() {
        return false;
    }
    if fs::copy(&path, &target).is_err() {
        return false;
    }
    prune_backups(dir);
    true
}

fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(backup_dir(dir)) else {
        return;
    };
    let prefix = format!("{}-", stem());
    let mut backups: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(&prefix) && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort();
    while backups.len() > MAX_BACKUPS {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
}

pub fn save_legacy_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    contents: &str,
) -> Result<PathBuf, String> {
    let dir = data_dir(app)?;
    let target = backup_dir(&dir).join(format!("legacy-localstorage-{}.json", now_millis()));
    fs::create_dir_all(target.parent().unwrap_or(&dir)).map_err(|error| error.to_string())?;
    fs::write(&target, contents).map_err(|error| error.to_string())?;
    Ok(target)
}

pub fn write_text_file(path: &str, contents: &str) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("expected an absolute path".into());
    }
    fs::write(&target, contents).map_err(|error| error.to_string())
}

pub fn read_text_file(path: &str) -> Result<String, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("expected an absolute path".into());
    }
    fs::read_to_string(&target).map_err(|error| error.to_string())
}

pub fn export_markdown_files(dir: &str, files: &[MarkdownFile]) -> Result<usize, String> {
    let root = PathBuf::from(dir);
    if !root.is_absolute() {
        return Err("expected an absolute directory".into());
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut written = 0;
    for file in files {
        let safe: String = file
            .name
            .chars()
            .map(|character| match character {
                '/' | '\\' | ':' | '\0' => '-',
                other => other,
            })
            .collect();
        let safe = safe.trim();
        if safe.is_empty() {
            continue;
        }
        let target = root.join(format!("{safe}.md"));
        fs::write(&target, &file.contents).map_err(|error| error.to_string())?;
        written += 1;
    }
    Ok(written)
}

#[cfg(target_os = "macos")]
pub fn open_dir(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn open_dir(path: &Path) -> Result<(), String> {
    let command = if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(command)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mote-test-{label}-{}", now_millis()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_replaces_contents() {
        let dir = temp_dir("atomic");
        let path = dir.join("doc.json");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_doc_quarantines_corrupt_file() {
        let dir = temp_dir("corrupt");
        let path = doc_path(&dir);
        fs::write(&path, "{not json").unwrap();
        assert!(read_doc(&dir).is_none());
        assert!(!path.exists());
        let quarantined = fs::read_dir(backup_dir(&dir)).unwrap().count();
        assert_eq!(quarantined, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_backups_only() {
        let dir = temp_dir("prune");
        let backups = backup_dir(&dir);
        fs::create_dir_all(&backups).unwrap();
        for index in 0..15 {
            fs::write(backups.join(format!("{}-{:06}.json", stem(), index)), "{}").unwrap();
        }
        fs::write(backups.join("legacy-localstorage-1.json"), "{}").unwrap();
        prune_backups(&dir);
        let mut remaining: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .collect();
        remaining.sort();
        assert_eq!(remaining.len(), MAX_BACKUPS + 1);
        assert!(remaining.iter().any(|name| name.contains("legacy-localstorage")));
        assert!(remaining.iter().any(|name| name.contains("000005")));
        assert!(!remaining.iter().any(|name| name.contains("000004")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_current_skips_missing_doc() {
        let dir = temp_dir("nodoc");
        assert!(!backup_current(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn markdown_export_sanitizes_names() {
        let dir = temp_dir("markdown");
        let files = vec![MarkdownFile {
            name: "a/b:c".into(),
            contents: "# hi".into(),
        }];
        let written = export_markdown_files(dir.to_str().unwrap(), &files).unwrap();
        assert_eq!(written, 1);
        assert_eq!(fs::read_to_string(dir.join("a-b-c.md")).unwrap(), "# hi");
        let _ = fs::remove_dir_all(&dir);
    }
}

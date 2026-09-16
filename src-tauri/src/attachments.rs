use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};

use crate::doc_store::atomic_write;

pub const ATTACHMENTS_DIR: &str = "attachments";
const THUMB_PREFIX: &str = "thumb-";
const THUMB_MAX: u32 = 512;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

const ALLOWED_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
];

#[derive(Serialize)]
pub struct ImportedAttachment {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub path: String,
    pub thumb: String,
}

#[derive(Serialize)]
pub struct ResolvedAttachment {
    pub path: Option<String>,
    pub thumb: Option<String>,
}

pub fn attachments_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(crate::doc_store::data_dir(app)?.join(ATTACHMENTS_DIR))
}

fn normalize_ext(ext: &str) -> Option<String> {
    let ext = ext.to_lowercase();
    if ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .and_then(normalize_ext)
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumb = image.thumbnail(THUMB_MAX, THUMB_MAX);
    let mut out = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    thumb.write_with_encoder(encoder).ok()?;
    Some(out)
}

pub fn import<R: Runtime>(
    app: &AppHandle<R>,
    source_path: &str,
) -> Result<ImportedAttachment, String> {
    let source = PathBuf::from(source_path);
    if !source.is_absolute() {
        return Err("expected an absolute path".into());
    }
    let ext = file_extension(&source)
        .ok_or_else(|| "that file type is not supported".to_string())?;
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("not a file".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("image is larger than 64 MB".into());
    }
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    let id = hash_bytes(&bytes);
    let dir = attachments_dir(app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let target = dir.join(format!("{id}.{ext}"));
    if !target.is_file() {
        atomic_write(&target, &bytes).map_err(|error| error.to_string())?;
    }

    let thumb_target = dir.join(format!("{THUMB_PREFIX}{id}.png"));
    if !thumb_target.is_file() {
        if let Some(png) = thumbnail(&bytes) {
            let _ = atomic_write(&thumb_target, &png);
        }
    }

    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(ImportedAttachment {
        id,
        name,
        ext,
        size: metadata.len(),
        path: target.to_string_lossy().into_owned(),
        thumb: if thumb_target.is_file() {
            thumb_target.to_string_lossy().into_owned()
        } else {
            target.to_string_lossy().into_owned()
        },
    })
}

pub fn resolve<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    ext: &str,
) -> Result<ResolvedAttachment, String> {
    let ext = normalize_ext(ext).ok_or_else(|| "unsupported extension".to_string())?;
    let dir = attachments_dir(app)?;
    let path = dir.join(format!("{id}.{ext}"));
    let thumb = dir.join(format!("{THUMB_PREFIX}{id}.png"));
    Ok(ResolvedAttachment {
        path: path.is_file().then(|| path.to_string_lossy().into_owned()),
        thumb: thumb.is_file().then(|| thumb.to_string_lossy().into_owned()),
    })
}

pub fn reveal<R: Runtime>(app: &AppHandle<R>, id: &str, ext: &str) -> Result<(), String> {
    let ext = normalize_ext(ext).ok_or_else(|| "unsupported extension".to_string())?;
    let path = attachments_dir(app)?.join(format!("{id}.{ext}"));
    if !path.is_file() {
        return Err("attachment not found".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("unsupported platform".into())
    }
}

pub fn prune<R: Runtime>(app: &AppHandle<R>, keep: &[String]) -> Result<usize, String> {
    let dir = attachments_dir(app)?;
    prune_dir(&dir, keep).map_err(|error| error.to_string())
}

pub(crate) fn prune_dir(dir: &Path, keep: &[String]) -> std::io::Result<usize> {
    let keep: HashSet<&str> = keep.iter().map(String::as_str).collect();
    let mut removed = 0;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let owner = if let Some(rest) = name.strip_prefix(THUMB_PREFIX) {
            rest.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(rest)
        } else {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(name)
        };
        if !keep.contains(owner) {
            fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_stable_and_distinct() {
        assert_eq!(hash_bytes(b"mote"), hash_bytes(b"mote"));
        assert_ne!(hash_bytes(b"mote"), hash_bytes(b"motes"));
        assert_eq!(hash_bytes(b"mote").len(), 64);
    }

    #[test]
    fn extension_allowlist() {
        assert_eq!(normalize_ext("PNG"), Some("png".into()));
        assert_eq!(normalize_ext("jpeg"), Some("jpeg".into()));
        assert_eq!(normalize_ext("pdf"), None);
        assert_eq!(normalize_ext(""), None);
    }

    #[test]
    fn thumbnail_is_png_for_supported_image() {
        let image = image::RgbaImage::from_pixel(800, 600, image::Rgba([255, 0, 0, 255]));
        let mut png = Vec::new();
        image
            .write_with_encoder(image::codecs::png::PngEncoder::new(&mut png))
            .unwrap();
        let thumb = thumbnail(&png).expect("thumbnail");
        assert_eq!(&thumb[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn prune_removes_orphans_and_keeps_referenced() {
        let dir = std::env::temp_dir().join(format!("mote-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("keep.png"), b"x").unwrap();
        fs::write(dir.join("thumb-keep.png"), b"x").unwrap();
        fs::write(dir.join("orphan.png"), b"x").unwrap();
        fs::write(dir.join("thumb-orphan.png"), b"x").unwrap();
        let removed = prune_dir(&dir, &["keep".to_string()]).unwrap();
        assert_eq!(removed, 2);
        assert!(dir.join("keep.png").is_file());
        assert!(dir.join("thumb-keep.png").is_file());
        assert!(!dir.join("orphan.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_missing_dir_is_ok() {
        let dir = std::env::temp_dir().join("mote-attach-missing-dir");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(prune_dir(&dir, &[]).unwrap(), 0);
    }
}

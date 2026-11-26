use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::Path,
};

use exif::{In, Tag, Value};
use image::{ExtendedColorType, ImageDecoder, ImageReader, metadata::Orientation};
use serde::Serialize;

use crate::{err::app_err::AppErr, services::files_folder::modified_millis};

/// Bytes read when looking for resolution data in PNG/JPEG headers.
const HEADER_SCAN_LEN: u64 = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileInfo {
    size: u64,
    /// Milliseconds since the Unix epoch; `None` when the platform can't report it.
    modified_at: Option<u64>,
    /// Present when the file is an image the `image` crate can read.
    image: Option<ImageInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageInfo {
    format: String,
    /// Size as displayed, i.e. after applying the EXIF orientation.
    width: u32,
    height: u32,
    color_model: &'static str,
    bits_per_channel: Option<u16>,
    /// Pixels per inch, when the file records it.
    resolution: Option<Resolution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct Resolution {
    x: f64,
    y: f64,
}

impl Resolution {
    fn new(x: f64, y: f64) -> Option<Self> {
        let valid = |value: f64| value.is_finite() && value > 0.0;
        (valid(x) && valid(y)).then_some(Resolution { x, y })
    }
}

pub(crate) fn file_info(path: &str) -> Result<FileInfo, AppErr> {
    let metadata = fs::metadata(path)?;
    let image = if metadata.is_file() { image_info(Path::new(path)) } else { None };
    Ok(FileInfo {
        size: metadata.len(),
        modified_at: modified_millis(&metadata),
        image,
    })
}

/// Reads the image header only; pixels are not decoded.
fn image_info(path: &Path) -> Option<ImageInfo> {
    let reader = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let format = reader.format()?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(error) => {
            tracing::warn!("Could not read image header of {}: {error}", path.display());
            return None;
        }
    };
    let (mut width, mut height) = decoder.dimensions();
    let color = decoder.original_color_type();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut resolution = exif_resolution(path).or_else(|| header_resolution(path));
    if matches!(
        orientation,
        Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH
    ) {
        std::mem::swap(&mut width, &mut height);
        resolution = resolution.map(|Resolution { x, y }| Resolution { x: y, y: x });
    }
    let (color_model, channels) = color_model(color);
    Some(ImageInfo {
        format: format!("{format:?}").to_uppercase(),
        width,
        height,
        color_model,
        bits_per_channel: (channels > 0).then(|| color.bits_per_pixel() / channels),
        resolution,
    })
}

/// Returns the color model name and its channel count (0 when unknown).
fn color_model(color: ExtendedColorType) -> (&'static str, u16) {
    use ExtendedColorType::*;
    match color {
        A8 => ("Alpha", 1),
        L1 | L2 | L4 | L8 | L16 => ("Grayscale", 1),
        La1 | La2 | La4 | La8 | La16 => ("Grayscale + alpha", 2),
        Rgb1 | Rgb2 | Rgb4 | Rgb5x1 | Rgb8 | Rgb16 | Bgr8 | Rgb32F => ("RGB", 3),
        Rgba1 | Rgba2 | Rgba4 | Rgba8 | Rgba16 | Bgra8 | Rgba32F => ("RGBA", 4),
        Cmyk8 | Cmyk16 => ("CMYK", 4),
        _ => ("Unknown", 0),
    }
}

/// Resolution from EXIF/TIFF tags (JPEG, TIFF, PNG, WebP, HEIF).
fn exif_resolution(path: &Path) -> Option<Resolution> {
    let file = File::open(path).ok()?;
    let exif = exif::Reader::new().read_from_container(&mut BufReader::new(file)).ok()?;
    let rational = |tag| match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Rational(values) => values.first().map(|value| value.to_f64()),
        _ => None,
    };
    let x = rational(Tag::XResolution)?;
    let y = rational(Tag::YResolution).unwrap_or(x);
    let unit = exif
        .get_field(Tag::ResolutionUnit, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .unwrap_or(2);
    let per_inch = match unit {
        2 => 1.0,
        3 => 2.54,
        _ => return None,
    };
    Resolution::new(x * per_inch, y * per_inch)
}

/// Resolution from a PNG `pHYs` chunk or a JPEG JFIF header.
fn header_resolution(path: &Path) -> Option<Resolution> {
    let mut header = Vec::new();
    File::open(path).ok()?.take(HEADER_SCAN_LEN).read_to_end(&mut header).ok()?;
    png_resolution(&header).or_else(|| jfif_resolution(&header))
}

fn png_resolution(data: &[u8]) -> Option<Resolution> {
    let mut rest = data.strip_prefix(b"\x89PNG\r\n\x1a\n")?;
    while rest.len() >= 8 {
        let len = u32::from_be_bytes(rest[0..4].try_into().ok()?) as usize;
        let kind = &rest[4..8];
        let body = rest.get(8..8 + len)?;
        match kind {
            // Pixels per unit on x and y, then the unit: 1 = metre, 0 = aspect ratio only.
            b"pHYs" if len == 9 && body[8] == 1 => {
                let per_inch = |at: usize| f64::from(u32::from_be_bytes(body[at..at + 4].try_into().unwrap())) * 0.0254;
                return Resolution::new(per_inch(0), per_inch(4));
            }
            // pHYs must come before the image data.
            b"pHYs" | b"IDAT" | b"IEND" => return None,
            _ => {}
        }
        rest = rest.get(len + 12..)?;
    }
    None
}

fn jfif_resolution(data: &[u8]) -> Option<Resolution> {
    // The JFIF APP0 segment directly follows the start-of-image marker:
    // length(2) "JFIF\0"(5) version(2) units(1) x density(2) y density(2).
    let segment = data.strip_prefix(&[0xFF, 0xD8, 0xFF, 0xE0])?.get(2..14)?;
    if &segment[0..5] != b"JFIF\0" {
        return None;
    }
    let per_inch = match segment[7] {
        1 => 1.0,
        2 => 2.54,
        _ => return None,
    };
    let density = |at: usize| f64::from(u16::from_be_bytes([segment[at], segment[at + 1]])) * per_inch;
    Resolution::new(density(8), density(10))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_phys(unit: u8) -> Vec<u8> {
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        for (kind, body) in [(&b"IHDR"[..], vec![0; 13]), (b"pHYs", {
            let mut body = 11811_u32.to_be_bytes().to_vec(); // 300 dpi
            body.extend(5906_u32.to_be_bytes()); // 150 dpi
            body.push(unit);
            body
        })] {
            data.extend((body.len() as u32).to_be_bytes());
            data.extend(kind);
            data.extend(&body);
            data.extend([0; 4]);
        }
        data
    }

    #[test]
    fn reads_png_phys_in_pixels_per_inch() {
        let resolution = png_resolution(&png_with_phys(1)).unwrap();
        assert_eq!((resolution.x.round(), resolution.y.round()), (300.0, 150.0));
        assert_eq!(png_resolution(&png_with_phys(0)), None);
    }

    #[test]
    fn reads_jfif_density() {
        let jfif = |units: u8| {
            let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
            data.extend(b"JFIF\0\x01\x02");
            data.push(units);
            data.extend([0, 72, 0, 96]);
            data
        };
        assert_eq!(jfif_resolution(&jfif(1)), Resolution::new(72.0, 96.0));
        assert_eq!(jfif_resolution(&jfif(2)), Resolution::new(72.0 * 2.54, 96.0 * 2.54));
        assert_eq!(jfif_resolution(&jfif(0)), None);
    }

    #[test]
    fn reports_size_and_image_header() {
        let path = std::env::temp_dir().join(format!("aligator-file-info-{}.png", std::process::id()));
        image::GrayImage::new(7, 3).save(&path).unwrap();
        let size = fs::metadata(&path).unwrap().len();
        let info = file_info(path.to_str().unwrap());
        let _ = fs::remove_file(&path);
        let info = info.ok().unwrap();
        assert_eq!(info.size, size);
        let image = info.image.unwrap();
        assert_eq!((image.format.as_str(), image.width, image.height), ("PNG", 7, 3));
        assert_eq!((image.color_model, image.bits_per_channel), ("Grayscale", Some(8)));
    }
}

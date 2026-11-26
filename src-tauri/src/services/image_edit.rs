use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::Path,
};

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder};
use serde::Deserialize;

use crate::err::app_err::AppErr;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ImageTransform {
    Rotate90,
    FlipVertical,
    FlipHorizontal,
    Crop(CropRect),
}

/// A crop area as fractions (0..=1) of the image's size at the point it is applied.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct CropRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CropRect {
    /// Converts to `(x, y, width, height)` in pixels, clamped to the image bounds.
    fn to_pixels(self, image_width: u32, image_height: u32) -> Result<(u32, u32, u32, u32), AppErr> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err(AppErr::new("Invalid crop area"));
        }
        let edge = |fraction: f64, size: u32| (fraction.clamp(0.0, 1.0) * f64::from(size)).round() as u32;
        let left = edge(self.x, image_width);
        let top = edge(self.y, image_height);
        let right = edge(self.x + self.width, image_width);
        let bottom = edge(self.y + self.height, image_height);
        if right <= left || bottom <= top {
            return Err(AppErr::new("The crop area is empty"));
        }
        Ok((left, top, right - left, bottom - top))
    }
}

impl From<image::ImageError> for AppErr {
    fn from(error: image::ImageError) -> Self {
        AppErr::new(format!("[image Error]: {error}"))
    }
}

// Formats that can be re-encoded without losing animation or switching compression.
const EDITABLE_FORMATS: [ImageFormat; 4] = [
    ImageFormat::Png,
    ImageFormat::Jpeg,
    ImageFormat::Bmp,
    ImageFormat::Tiff,
];

fn editable(format: Option<ImageFormat>) -> Result<ImageFormat, AppErr> {
    format
        .filter(|format| EDITABLE_FORMATS.contains(format))
        .ok_or_else(|| AppErr::new("This image format cannot be edited"))
}

/// Applies `transforms` in order and writes the result to `destination`,
/// or back over `path` when no destination is given.
pub(crate) fn transform_image(
    path: &str,
    transforms: &[ImageTransform],
    destination: Option<&str>,
) -> Result<(), AppErr> {
    // Resolve shortcuts so the target file is edited instead of being replaced.
    let source = fs::canonicalize(path)?;
    let reader = ImageReader::open(&source)?.with_guessed_format()?;
    let source_format = editable(reader.format())?;

    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    // The saved file has no EXIF data, so bake the displayed orientation into the pixels.
    image.apply_orientation(orientation);

    for transform in transforms {
        image = match transform {
            ImageTransform::Rotate90 => image.rotate90(),
            ImageTransform::FlipVertical => image.flipv(),
            ImageTransform::FlipHorizontal => image.fliph(),
            ImageTransform::Crop(rect) => {
                let (x, y, width, height) = rect.to_pixels(image.width(), image.height())?;
                image.crop_imm(x, y, width, height)
            }
        };
    }

    let (path, format) = match destination {
        Some(destination) => {
            let destination = std::path::PathBuf::from(destination);
            let format = editable(ImageFormat::from_path(&destination).ok())?;
            (destination, format)
        }
        None => (source, source_format),
    };

    let file_name = path
        .file_name()
        .ok_or_else(|| AppErr::new("Invalid image path"))?
        .to_string_lossy();
    let temp_path = path.with_file_name(format!(".{file_name}.aligator-tmp"));

    let result = write_image(&image, &temp_path, format)
        .and_then(|_| fs::rename(&temp_path, &path).map_err(AppErr::from));
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn write_image(image: &DynamicImage, path: &Path, format: ImageFormat) -> Result<(), AppErr> {
    let mut writer = BufWriter::new(File::create(path)?);
    match format {
        ImageFormat::Jpeg => image.write_with_encoder(JpegEncoder::new_with_quality(&mut writer, 95))?,
        _ => image.write_to(&mut writer, format)?,
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::CropRect;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> CropRect {
        CropRect { x, y, width, height }
    }

    #[test]
    fn crop_rect_rounds_to_pixels() {
        assert_eq!(rect(0.25, 0.5, 0.5, 0.25).to_pixels(200, 100).ok(), Some((50, 50, 100, 25)));
    }

    #[test]
    fn crop_rect_is_clamped_to_the_image() {
        assert_eq!(rect(-0.2, 0.9, 1.5, 0.5).to_pixels(100, 100).ok(), Some((0, 90, 100, 10)));
    }

    #[test]
    fn crop_rect_rejects_empty_or_invalid_areas() {
        assert!(rect(0.5, 0.5, 0.001, 0.5).to_pixels(100, 100).is_err());
        assert!(rect(f64::NAN, 0.0, 1.0, 1.0).to_pixels(100, 100).is_err());
    }
}

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

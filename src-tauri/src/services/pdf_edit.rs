use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::PathBuf,
};

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::err::app_err::AppErr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PageTransform {
    Rotate90,
    FlipVertical,
    FlipHorizontal,
}

/// Edits for one page (numbered from 1), applied in order as they look on screen.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PageEdit {
    page: u32,
    transforms: Vec<PageTransform>,
}

impl From<lopdf::Error> for AppErr {
    fn from(error: lopdf::Error) -> Self {
        AppErr::new(format!("[pdf Error]: {error}"))
    }
}

/// The net effect of a list of on-screen edits: extra clockwise quarter turns for `/Rotate`,
/// and mirroring of the page's own x and y axes (before its rotation is applied).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PageChange {
    quarter_turns: u8,
    mirror_x: bool,
    mirror_y: bool,
}

impl PageChange {
    fn new(rotation: i64, transforms: &[PageTransform]) -> Self {
        let mut change = PageChange { quarter_turns: 0, mirror_x: false, mirror_y: false };
        for transform in transforms {
            // On a quarter-turned page, the screen's horizontal axis is the page's y axis.
            let sideways = (rotation / 90 + i64::from(change.quarter_turns)) % 2 != 0;
            match transform {
                PageTransform::Rotate90 => change.quarter_turns = (change.quarter_turns + 1) % 4,
                PageTransform::FlipHorizontal if sideways => change.mirror_y = !change.mirror_y,
                PageTransform::FlipHorizontal => change.mirror_x = !change.mirror_x,
                PageTransform::FlipVertical if sideways => change.mirror_x = !change.mirror_x,
                PageTransform::FlipVertical => change.mirror_y = !change.mirror_y,
            }
        }
        change
    }

    fn is_empty(&self) -> bool {
        self.quarter_turns == 0 && !self.mirror_x && !self.mirror_y
    }
}

/// A mirror transform `x' = sx·x + tx, y' = sy·y + ty` that flips content within a page box.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Mirror {
    sx: f32,
    tx: f32,
    sy: f32,
    ty: f32,
}

impl Mirror {
    fn new(change: PageChange, [left, bottom, right, top]: [f32; 4]) -> Option<Self> {
        if !change.mirror_x && !change.mirror_y {
            return None;
        }
        let (sx, tx) = if change.mirror_x { (-1.0, left + right) } else { (1.0, 0.0) };
        let (sy, ty) = if change.mirror_y { (-1.0, bottom + top) } else { (1.0, 0.0) };
        Some(Mirror { sx, tx, sy, ty })
    }

    fn point(&self, x: f32, y: f32) -> (f32, f32) {
        (self.sx * x + self.tx, self.sy * y + self.ty)
    }
}

/// Applies per-page edits and writes the result to `destination`, or back over `path`.
///
/// The edits are appended as an incremental update, so every untouched page, font and image
/// stays byte-for-byte as it was.
pub(crate) fn transform_pdf(path: &str, edits: &[PageEdit], destination: Option<&str>) -> Result<(), AppErr> {
    // Resolve shortcuts so the target file is edited instead of being replaced.
    let source = fs::canonicalize(path)?;
    let mut document = IncrementalDocument::load(&source)?;
    if document.get_prev_documents().is_encrypted() {
        return Err(AppErr::new("Password-protected PDFs cannot be edited"));
    }

    let pages = document.get_prev_documents().get_pages();
    let mut changed = false;
    for edit in edits {
        let page_id = *pages
            .get(&edit.page)
            .ok_or_else(|| AppErr::new(format!("Page {} does not exist", edit.page)))?;
        changed |= edit_page(&mut document, page_id, &edit.transforms)?;
    }

    let target = match destination {
        Some(destination) => PathBuf::from(destination),
        None => source.clone(),
    };
    if !changed && target == source {
        return Ok(());
    }

    let file_name = target
        .file_name()
        .ok_or_else(|| AppErr::new("Invalid PDF path"))?
        .to_string_lossy();
    let temp_path = target.with_file_name(format!(".{file_name}.aligator-tmp"));
    let result = write_pdf(&mut document, changed, &temp_path)
        .and_then(|_| fs::rename(&temp_path, &target).map_err(AppErr::from));
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn write_pdf(document: &mut IncrementalDocument, changed: bool, path: &std::path::Path) -> Result<(), AppErr> {
    let mut writer = BufWriter::new(File::create(path)?);
    if !changed {
        writer.write_all(document.get_prev_documents_bytes())?;
    } else if document.get_prev_documents().xref_start == 0 {
        // The file was repaired while loading, so there is no valid cross-reference table to
        // append to; write a complete new file instead.
        let mut full = document.get_prev_documents().clone();
        full.max_id = full.max_id.max(document.new_document.max_id);
        full.objects.append(&mut document.new_document.objects);
        full.save_to(&mut writer)?;
    } else {
        document.save_to(&mut writer)?;
    }
    writer.flush()?;
    Ok(())
}

/// Records the page's changes in the incremental update. Returns false when the edits cancel out.
fn edit_page(document: &mut IncrementalDocument, page_id: ObjectId, transforms: &[PageTransform]) -> Result<bool, AppErr> {
    let prev = document.get_prev_documents();
    let rotation = inherited(prev, page_id, b"Rotate")
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(0)
        .rem_euclid(360);
    let change = PageChange::new(rotation, transforms);
    if change.is_empty() {
        return Ok(false);
    }
    let page_box = inherited(prev, page_id, b"CropBox")
        .or_else(|| inherited(prev, page_id, b"MediaBox"))
        .and_then(rectangle)
        .unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let mirror = Mirror::new(change, page_box);
    let contents = content_streams(prev, page_id);
    let annotations = prev.get_dictionary(page_id)?.get(b"Annots").ok().cloned();

    document.opt_clone_object_to_new_document(page_id)?;
    let new_document = &mut document.new_document;

    if change.quarter_turns > 0 {
        let rotation = (rotation + 90 * i64::from(change.quarter_turns)) % 360;
        new_document.get_dictionary_mut(page_id)?.set("Rotate", rotation);
    }

    if let Some(mirror) = mirror {
        if !contents.is_empty() {
            // Wrap the existing content in its own graphics state with the mirror matrix.
            let begin = format!("q {} 0 0 {} {} {} cm\n", mirror.sx, mirror.sy, mirror.tx, mirror.ty);
            let begin_id = new_document.add_object(Stream::new(Dictionary::new(), begin.into_bytes()));
            let end_id = new_document.add_object(Stream::new(Dictionary::new(), b"\nQ\n".to_vec()));
            let mut wrapped = Vec::with_capacity(contents.len() + 2);
            wrapped.push(Object::Reference(begin_id));
            wrapped.extend(contents);
            wrapped.push(Object::Reference(end_id));
            new_document.get_dictionary_mut(page_id)?.set("Contents", wrapped);
        }
        if let Some(annotations) = annotations {
            mirror_annotations(document, page_id, annotations, mirror)?;
        }
    }
    Ok(true)
}

/// Looks up a page attribute, following the page tree for inheritable ones.
fn inherited<'a>(document: &'a Document, page_id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut dictionary = document.get_dictionary(page_id).ok()?;
    // The depth limit guards against cyclic page trees.
    for _ in 0..64 {
        if let Ok(value) = dictionary.get(key) {
            return document.dereference(value).ok().map(|(_, value)| value);
        }
        let parent = dictionary.get(b"Parent").ok()?.as_reference().ok()?;
        dictionary = document.get_dictionary(parent).ok()?;
    }
    None
}

fn rectangle(value: &Object) -> Option<[f32; 4]> {
    let values = value.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    let mut numbers = [0.0; 4];
    for (number, value) in numbers.iter_mut().zip(values) {
        *number = value.as_float().ok()?;
    }
    let [x1, y1, x2, y2] = numbers;
    Some([x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)])
}

/// The page's content stream references, in drawing order.
fn content_streams(document: &Document, page_id: ObjectId) -> Vec<Object> {
    let Ok(contents) = document.get_dictionary(page_id).and_then(|page| page.get(b"Contents")) else {
        return Vec::new();
    };
    match contents {
        Object::Reference(id) => match document.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            Ok(_) => vec![contents.clone()],
            Err(_) => Vec::new(),
        },
        Object::Array(items) => items.clone(),
        // A direct stream is not allowed by the spec; keep it as it is.
        other => vec![other.clone()],
    }
}

/// Moves annotations (links, highlights, form fields…) to where their area is after mirroring.
fn mirror_annotations(
    document: &mut IncrementalDocument,
    page_id: ObjectId,
    annotations: Object,
    mirror: Mirror,
) -> Result<(), AppErr> {
    let (array_id, items) = match &annotations {
        Object::Reference(id) => match document.get_prev_documents().get_object(*id) {
            Ok(Object::Array(items)) => (Some(*id), items.clone()),
            _ => return Ok(()),
        },
        Object::Array(items) => (None, items.clone()),
        _ => return Ok(()),
    };

    let mut mirrored_items = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Object::Reference(id) => {
                if document.get_prev_documents().get_dictionary(id).is_ok() {
                    document.opt_clone_object_to_new_document(id)?;
                    mirror_annotation(document.new_document.get_dictionary_mut(id)?, mirror);
                }
                mirrored_items.push(Object::Reference(id));
            }
            Object::Dictionary(mut annotation) => {
                mirror_annotation(&mut annotation, mirror);
                mirrored_items.push(Object::Dictionary(annotation));
            }
            other => mirrored_items.push(other),
        }
    }

    match array_id {
        Some(id) => document.new_document.set_object(id, mirrored_items),
        None => document.new_document.get_dictionary_mut(page_id)?.set("Annots", mirrored_items),
    }
    Ok(())
}

fn mirror_annotation(annotation: &mut Dictionary, mirror: Mirror) {
    if let Some([left, bottom, right, top]) = annotation.get(b"Rect").ok().and_then(rectangle) {
        let (x1, y1) = mirror.point(left, bottom);
        let (x2, y2) = mirror.point(right, top);
        let rect: Vec<Object> = [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]
            .into_iter()
            .map(Object::Real)
            .collect();
        annotation.set("Rect", rect);
    }
    let quad_points = annotation.get(b"QuadPoints").ok().and_then(|value| value.as_array().ok()).and_then(|values| {
        values.iter().map(|value| value.as_float().ok()).collect::<Option<Vec<f32>>>()
    });
    if let Some(quad_points) = quad_points.filter(|values| values.len() % 2 == 0) {
        let mirrored: Vec<Object> = quad_points
            .chunks_exact(2)
            .flat_map(|pair| {
                let (x, y) = mirror.point(pair[0], pair[1]);
                [Object::Real(x), Object::Real(y)]
            })
            .collect();
        annotation.set("QuadPoints", mirrored);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PageTransform::*;
    use lopdf::dictionary;

    fn change(quarter_turns: u8, mirror_x: bool, mirror_y: bool) -> PageChange {
        PageChange { quarter_turns, mirror_x, mirror_y }
    }

    #[test]
    fn on_screen_flips_follow_the_page_rotation() {
        assert_eq!(PageChange::new(0, &[FlipHorizontal]), change(0, true, false));
        assert_eq!(PageChange::new(90, &[FlipHorizontal]), change(0, false, true));
        assert_eq!(PageChange::new(0, &[Rotate90, FlipVertical]), change(1, true, false));
        assert_eq!(PageChange::new(270, &[Rotate90, FlipVertical]), change(1, false, true));
    }

    #[test]
    fn edits_that_cancel_out_change_nothing() {
        assert!(PageChange::new(0, &[FlipHorizontal, FlipHorizontal]).is_empty());
        assert!(PageChange::new(90, &[Rotate90; 4]).is_empty());
    }

    fn sample_pdf(path: &std::path::Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for number in 1..=2 {
            let content = format!("BT /F1 24 Tf 72 700 Td (Page {number}) Tj ET");
            let content_id = document.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
            let link = dictionary! { "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![10.into(), 20.into(), 110.into(), 40.into()] };
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Annots" => vec![Object::Dictionary(link)],
            });
            kids.push(Object::Reference(page_id));
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => 2,
                "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
                "Rotate" => 90,
            }),
        );
        let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        document.save(path).expect("write sample PDF");
    }

    #[test]
    fn only_the_edited_page_changes() {
        let path = std::env::temp_dir().join(format!("aligator-pdf-edit-{}.pdf", std::process::id()));
        sample_pdf(&path);
        let original = fs::read(&path).expect("read sample PDF");

        let edits = [PageEdit { page: 2, transforms: vec![Rotate90, FlipVertical] }];
        assert!(transform_pdf(path.to_str().expect("utf-8 path"), &edits, None).is_ok());
        let saved = fs::read(&path).expect("read edited PDF");
        let _ = fs::remove_file(&path);

        // An incremental update keeps the original bytes as a prefix.
        assert_eq!(&saved[..original.len()], &original[..]);

        let document = Document::load_mem(&saved).expect("parse edited PDF");
        let pages = document.get_pages();
        let first = document.get_dictionary(pages[&1]).expect("page 1");
        let second = document.get_dictionary(pages[&2]).expect("page 2");
        assert!(first.get(b"Rotate").is_err());
        assert!(first.get(b"Contents").expect("contents").as_reference().is_ok());
        assert_eq!(second.get(b"Rotate").and_then(Object::as_i64).ok(), Some(180));

        // Inherited 90° + one more turn is upside down, so an on-screen vertical flip mirrors the page's y axis.
        let contents = second.get(b"Contents").and_then(Object::as_array).expect("wrapped contents");
        assert_eq!(contents.len(), 3);
        let begin = document.get_object(contents[0].as_reference().expect("ref")).and_then(Object::as_stream).expect("stream");
        assert_eq!(String::from_utf8_lossy(&begin.content), "q 1 0 0 -1 0 800 cm\n");

        let annotations = second.get(b"Annots").and_then(Object::as_array).expect("annotations");
        let link = annotations[0].as_dict().expect("link");
        let rect: Vec<f32> = link.get(b"Rect").and_then(Object::as_array).expect("rect").iter().map(|value| value.as_float().expect("number")).collect();
        assert_eq!(rect, [10.0, 760.0, 110.0, 780.0]);
    }
}

//! The player's picture: a native view under the window's GPUI view, which
//! AppleBackend draws into (AVSampleBufferDisplayLayer and its subtitle
//! layer). While a video plays the window is transparent, and the play screen
//! paints nothing over its video slot, so the picture shows through there and
//! the controls draw over it. This is how GPUI itself puts a blur under a
//! transparent window.

use std::sync::Arc;

use gpui_kit::Window;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use player::AppleBackend;
use player::backend::Backend;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub struct VideoView {
    backend: Arc<AppleBackend>,
    view: Retained<NSView>,
}

impl VideoView {
    /// Adds an empty view below `window`'s GPUI view; `set_frame` places it.
    pub fn open(window: &Window) -> Result<VideoView, String> {
        let mtm = MainThreadMarker::new().ok_or("The player starts on the main thread")?;
        let handle = HasWindowHandle::window_handle(window).map_err(|err| format!("No native window: {err}"))?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return Err("No AppKit window".into());
        };
        // SAFETY: GPUI's handle points at its live NSView, which the window keeps.
        let gpui_view: &NSView = unsafe { appkit.ns_view.cast::<NSView>().as_ref() };
        // SAFETY: the window's content view outlives this call; we retain it.
        let parent = unsafe { gpui_view.superview() }.ok_or("GPUI's view has no superview")?;
        let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO);
        parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(gpui_view));
        let backend = AppleBackend::new();
        // SAFETY: `view` is a live NSView, kept alive by self until after detach.
        unsafe { backend.attach(Retained::as_ptr(&view) as *mut std::ffi::c_void) };
        Ok(VideoView { backend, view })
    }

    pub fn backend(&self) -> Arc<dyn Backend> {
        self.backend.clone()
    }

    /// Puts the picture over a rect of the window's content, in points from
    /// its top left: [left, top, width, height].
    pub fn set_frame(&self, [left, top, width, height]: [f64; 4]) {
        // SAFETY: the content view holds our view until Drop removes it.
        if let Some(parent) = unsafe { self.view.superview() } {
            // AppKit counts y from the bottom unless the view is flipped.
            let y = if parent.isFlipped() { top } else { parent.bounds().size.height - top - height };
            self.view.setFrame(NSRect::new(NSPoint::new(left, y), NSSize::new(width, height)));
        }
        self.backend.set_frame([0.0, 0.0, width, height]);
    }
}

impl Drop for VideoView {
    fn drop(&mut self) {
        self.backend.detach();
        self.view.removeFromSuperview();
    }
}

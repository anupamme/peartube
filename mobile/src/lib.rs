//! PearTube's Dioxus app (the Mac app): a webview UI over a Bare worklet that
//! runs the relay's P2P core on the device. Android has its own app in android/.

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple_view;
pub mod player;
pub mod settings;
pub mod soundfont;
pub mod worker;

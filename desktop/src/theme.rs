//! The Android app's palette (android/.../ui/Theme.kt), over gpui-component's
//! dark theme, so its inputs, menus and buttons match the rest of the window.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, px, rgb};

pub const BG: u32 = 0x0a0c10;
pub const CARD: u32 = 0x131720;
pub const CARD_ELEVATED: u32 = 0x1a202c;
pub const LINE: u32 = 0x232a38;
pub const INK: u32 = 0xf3f5fa;
pub const DIM: u32 = 0x8a93a6;
pub const BRAND: u32 = 0x9147ff;
pub const ACCENT: u32 = 0x4ade80;
pub const DANGER: u32 = 0xff6b6b;
pub fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    Theme::update(cx, |theme| {
        let color = |hex: u32| -> Hsla { rgb(hex).into() };
        theme.background = color(BG);
        theme.foreground = color(INK);
        theme.muted_foreground = color(DIM);
        theme.border = color(LINE);
        theme.input = color(LINE);
        theme.popover = color(CARD_ELEVATED);
        let brand = color(BRAND);
        theme.primary = brand;
        theme.primary_foreground = color(0xffffff);
        theme.button_primary = brand;
        theme.button_primary_hover = brand.opacity(0.9);
        theme.button_primary_active = brand.opacity(0.8);
        theme.button_primary_foreground = color(0xffffff);
        theme.ring = brand;
        theme.caret = brand;
        theme.selection = brand.opacity(0.35);
        theme.slider_bar = brand;
        theme.slider_thumb = color(0xffffff);
        theme.danger = color(DANGER);
        theme.font_size = px(14.);
        theme.radius = px(12.);
    });
}

//! The list: the tracker's entries grouped by title, with search, the peer
//! count, what LAN discovery is doing, and the way into Settings.

use gpui_kit::component::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::Entry;

use crate::app::PearTube;
use crate::theme::{CARD, DIM, LINE};

pub fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB { format!("{:.1} GB", bytes as f64 / GB as f64) }
    else if bytes >= MB { format!("{:.1} MB", bytes as f64 / MB as f64) }
    else if bytes >= KB { format!("{:.1} KB", bytes as f64 / KB as f64) }
    else { format!("{bytes} B") }
}

/// "S01E02" for an episode id (imdb:tt0944947:s01e02), else "Movie".
pub fn label(id: &str) -> String {
    if let Some((_, s)) = id.rsplit_once(':') {
        let b = s.as_bytes();
        let valid = (b.len() == 6 || b.len() == 7)
            && (b[0] == b's' || b[0] == b'S')
            && b[1].is_ascii_digit() && b[2].is_ascii_digit()
            && (b[3] == b'e' || b[3] == b'E')
            && b[4].is_ascii_digit() && b[5].is_ascii_digit()
            && (b.len() == 6 || b[6].is_ascii_digit());
        if valid { return s.to_ascii_uppercase(); }
    }
    "Movie".to_string()
}

pub fn origin(entry: &Entry) -> &'static str {
    if entry.local { "on this device" } else { "from peers" }
}

/// The page's column: full width in a narrow window, centred in a wide one.
pub fn column() -> Div {
    v_flex().w_full().max_w(px(760.)).mx_auto().px_4()
}

impl PearTube {
    pub fn render_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.as_ref();
        let peers = status.map_or(0, |s| s.peers + s.lan_peers);
        let bytes = status.map_or(0, |s| s.blob_bytes);
        let tracker = status.map_or(self.settings.tracker.as_str(), |s| s.tracker.as_str());
        let short = if tracker.len() >= 8 { format!("{}…", &tracker[..8]) } else { tracker.to_string() };
        let lan = status.and_then(|s| s.lan.clone());

        let query = self.search.read(cx).value().to_lowercase();
        let mut rows: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| query.is_empty() || e.title.to_lowercase().contains(&query) || e.id.to_lowercase().contains(&query))
            .collect();
        // Grouped by title: groups in case-insensitive order, episodes by id.
        rows.sort_by_cached_key(|e| (e.title.to_lowercase(), e.title.clone(), e.id.clone()));

        let empty = if self.entries.is_empty() {
            if self.status.is_none() { "Joining the tracker…" } else { "Nothing in this tracker yet. Entries appear as relays announce them." }
        } else {
            "No matching entries."
        };
        let mut groups = Vec::new();
        for group in rows.chunk_by(|a, b| a.title == b.title) {
            let rows: Vec<_> = group.iter().enumerate().map(|(i, entry)| self.render_row(i, entry, cx)).collect();
            groups.push(
                v_flex()
                    .child(div().mt_4().mb_2().ml_1().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child(group[0].title.clone()))
                    .child(v_flex().bg(rgb(CARD)).border_1().border_color(rgb(LINE)).rounded(px(10.)).overflow_hidden().children(rows)),
            );
        }

        v_flex()
            .size_full()
            .child(
                div().border_b_1().border_color(rgb(LINE)).child(
                    column()
                        .pt_3()
                        .pb_3()
                        .child(
                            h_flex()
                                .justify_between()
                                .child(div().text_xl().font_weight(FontWeight::BOLD).child("PearTube"))
                                .child(Button::new("settings").ghost().icon(IconName::Settings).on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx)))),
                        )
                        .child(div().text_sm().text_color(rgb(DIM)).child(format!("{peers} peers · {} · {short}", format_bytes(bytes))))
                        .when_some(lan, |this, lan| this.child(div().text_sm().text_color(rgb(DIM)).child(format!("LAN {lan}"))))
                        .child(div().mt_3().child(Input::new(&self.search).cleanable(true))),
                ),
            )
            .child(
                div().id("entries").flex_1().min_h_0().overflow_y_scrollbar().child(
                    column()
                        .pb_6()
                        .when(rows.is_empty(), |this| this.child(div().py_12().px_5().text_center().text_color(rgb(DIM)).child(empty)))
                        .children(groups),
                ),
            )
    }

    fn render_row(&self, index: usize, entry: &Entry, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let play = entry.clone();
        div()
            // The tracker key: an id can have several entries.
            .id(SharedString::from(entry.key.clone()))
            .flex()
            .flex_col()
            .justify_center()
            .min_h(px(44.))
            .px(px(14.))
            .py(px(10.))
            .when(index > 0, |this| this.border_t_1().border_color(rgb(LINE)))
            .cursor_pointer()
            .hover(|style| style.bg(hsla(0., 0., 1., 0.04)))
            .on_click(cx.listener(move |this, _, window, cx| this.play(play.clone(), window, cx)))
            .child(div().font_weight(FontWeight::MEDIUM).child(label(&entry.id)))
            .child(div().mt(px(2.)).text_sm().text_color(rgb(DIM)).child(format!("{} · {}", format_bytes(entry.size), origin(entry))))
    }
}

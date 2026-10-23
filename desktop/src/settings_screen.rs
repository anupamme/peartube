//! Settings: the tracker to join, optional blind relays and DHT bootstrap,
//! LAN discovery, and the MIDI SoundFont. Save restarts the worker with them.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::Settings;
use peartube::soundfont;

use crate::app::{PearTube, Screen};
use crate::list::column;
use crate::theme::{DANGER, DIM, LINE};

pub struct SettingsForm {
    tracker: Entity<InputState>,
    relays: Entity<TextareaState>,
    bootstrap: Entity<TextareaState>,
    lan: bool,
    private_routing: bool,
    error: Option<SharedString>,
}

impl SettingsForm {
    pub fn new(settings: &Settings, window: &mut Window, cx: &mut Context<PearTube>) -> Self {
        SettingsForm {
            tracker: cx.new(|cx| InputState::new(window, cx).default_value(settings.tracker.clone())),
            relays: cx.new(|cx| TextareaState::new(window, cx).rows(3).default_value(settings.relay_through.join(", "))),
            bootstrap: cx.new(|cx| TextareaState::new(window, cx).rows(3).default_value(settings.bootstrap.join(", "))),
            lan: settings.lan_discovery,
            private_routing: settings.private_routing,
            error: None,
        }
    }
}

fn field(label: &'static str, hint: &'static str, input: impl IntoElement) -> Div {
    v_flex()
        .gap_1()
        .child(div().font_weight(FontWeight::SEMIBOLD).child(label))
        .child(div().text_sm().text_color(rgb(DIM)).child(hint))
        .child(div().mt_1().child(input))
}

fn inline_error(error: SharedString) -> Div {
    div().text_sm().text_color(rgb(DANGER)).child(error)
}

impl PearTube {
    pub fn render_settings(&self, form: &SettingsForm, cx: &mut Context<Self>) -> impl IntoElement {
        let bank = &self.bank;
        v_flex()
            .size_full()
            .child(
                div().border_b_1().border_color(rgb(LINE)).child(
                    column().py_3().child(
                        h_flex()
                            .justify_between()
                            .min_h(px(32.))
                            .child(div().text_xl().font_weight(FontWeight::BOLD).child("Settings"))
                            .when(!self.settings.tracker.is_empty(), |this| {
                                this.child(Button::new("cancel").ghost().label("Cancel").on_click(cx.listener(|this, _, _, cx| this.show_list(cx))))
                            }),
                    ),
                ),
            )
            .child(
                div().id("settings").flex_1().min_h_0().overflow_y_scrollbar().child(
                    column()
                        .py_4()
                        .gap_5()
                        .when_some(form.error.clone(), |this, error| this.child(inline_error(error)))
                        .child(field("Tracker key", "64 hex characters, from a relay's /v1/status", Input::new(&form.tracker)))
                        .child(field("Blind relays", "Optional relay keys, for networks where peers cannot connect directly", Textarea::new(&form.relays)))
                        .child(field("DHT bootstrap", "Optional host:port list for a private DHT. Empty uses the public DHT.", Textarea::new(&form.bootstrap)))
                        .child(
                            v_flex()
                                .gap_1()
                                .child(Checkbox::new("lan").checked(form.lan).label("Find relays on this network").on_click(cx.listener(|this, checked: &bool, _, cx| {
                                    if let Screen::Settings(form) = &mut this.screen {
                                        form.lan = *checked;
                                        cx.notify();
                                    }
                                })))
                                .child(div().text_sm().text_color(rgb(DIM)).child(
                                    "Over mDNS, on this Mac's Wi-Fi or Ethernet, for relays that run with PEARTUBE_LAN_HOST. Turn it on where peers on one network cannot reach each other through the internet.",
                                )),
                        )
                        .child(
                            v_flex()
                                .gap_1()
                                .child(Checkbox::new("private-routing").checked(form.private_routing).label("Private DHT routing").on_click(cx.listener(|this, checked: &bool, _, cx| {
                                    if let Screen::Settings(form) = &mut this.screen {
                                        form.private_routing = *checked;
                                        cx.notify();
                                    }
                                })))
                                .child(div().text_sm().text_color(rgb(DIM)).child(
                                    "Route peer connections over 4-hop encrypted relay circuits. Every peer you connect to must also run with private routing.",
                                )),
                        )
                        .child(
                            v_flex()
                                .gap_1()
                                .child(div().font_weight(FontWeight::SEMIBOLD).child("MIDI SoundFont"))
                                .child(div().text_sm().text_color(rgb(DIM)).child(
                                    "Choose your own SoundFont 2 (.sf2), up to 256 MiB. No bank is bundled. Changes are saved immediately, only on this Mac.",
                                ))
                                .when_some(bank.error.clone(), |this, error| this.child(inline_error(error)))
                                .child(div().text_sm().text_color(rgb(DIM)).child(if bank.selected {
                                    "A SoundFont is selected."
                                } else {
                                    "No SoundFont selected. MIDI needs one to play."
                                }))
                                .child(
                                    h_flex()
                                        .mt_1()
                                        .gap_2()
                                        .child(
                                            Button::new("choose-soundfont")
                                                .label(if bank.busy { "Importing…" } else { "Choose .sf2 file" })
                                                .disabled(bank.busy)
                                                .on_click(cx.listener(|this, _, _, cx| this.choose_soundfont(cx))),
                                        )
                                        .when(bank.selected, |this| {
                                            this.child(
                                                Button::new("remove-soundfont")
                                                    .ghost()
                                                    .label("Remove SoundFont")
                                                    .disabled(bank.busy)
                                                    .on_click(cx.listener(|this, _, _, cx| this.clear_soundfont(cx))),
                                            )
                                        }),
                                ),
                        )
                        .child(h_flex().child(Button::new("save").primary().label("Save").on_click(cx.listener(|this, _, _, cx| this.save_settings(cx))))),
                ),
            )
    }

    fn save_settings(&mut self, cx: &mut Context<Self>) {
        let Screen::Settings(form) = &mut self.screen else { return };
        let parsed = Settings::parse(&form.tracker.read(cx).value(), &form.relays.read(cx).value(), &form.bootstrap.read(cx).value(), form.lan, form.private_routing);
        match parsed.and_then(|new| new.save().map(|()| new)) {
            Err(err) => {
                form.error = Some(err.into());
                cx.notify();
            }
            Ok(new) => {
                self.settings = new.clone();
                self.status = None;
                self.entries.clear();
                self.show_list(cx);
                self.start(new, cx);
            }
        }
    }

    fn choose_soundfont(&mut self, cx: &mut Context<Self>) {
        // No type filter in GPUI's open panel: import refuses anything that is
        // not a complete SoundFont 2.
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Choose".into()) });
        self.bank.busy = true;
        self.bank.error = None;
        self.bank.task = Some(cx.spawn(async move |this, cx| {
            let result = match picked.await {
                Ok(Ok(Some(paths))) => match paths.into_iter().next() {
                    Some(path) => soundfont::import(path).await,
                    None => Ok(()),
                },
                Ok(Err(err)) => Err(err.to_string()),
                // Cancelled.
                Ok(Ok(None)) | Err(_) => Ok(()),
            };
            let _ = this.update(cx, |this, cx| {
                this.bank.busy = false;
                this.bank.error = result.err().map(Into::into);
                this.bank.selected = soundfont::path().is_some();
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn clear_soundfont(&mut self, cx: &mut Context<Self>) {
        self.bank.error = soundfont::clear().err().map(Into::into);
        self.bank.selected = soundfont::path().is_some();
        cx.notify();
    }
}

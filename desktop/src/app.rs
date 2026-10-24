//! The window's root view: what the app knows (its settings, the worker's
//! status and the tracker's entries) and which screen shows it.

use futures_util::StreamExt;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{IconName, Sizable as _, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::Settings;
use peartube::soundfont;
use peartube::worker::{Entry, Event, Status, worker};

use crate::play::{PlayEvent, PlayScreen};
use crate::settings_screen::SettingsForm;
use crate::theme::{BG, INK};

pub enum Screen {
    List,
    Settings(SettingsForm),
    Play(Entity<PlayScreen>),
}

/// The SoundFont picker. Its import runs here, in the root, so leaving
/// Settings does not cancel it.
pub struct Bank {
    pub selected: bool,
    pub busy: bool,
    pub error: Option<SharedString>,
    pub task: Option<Task<()>>,
}

pub struct PearTube {
    pub settings: Settings,
    pub status: Option<Status>,
    pub entries: Vec<Entry>,
    pub error: Option<SharedString>,
    pub screen: Screen,
    pub search: Entity<InputState>,
    pub bank: Bank,
    /// The latest start; a newer one replaces it. The worklet runs starts in order.
    start: Option<Task<()>>,
    player_events: Option<Subscription>,
    _worker: Task<()>,
    _search: Subscription,
}

impl PearTube {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = Settings::load();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search title or ID…"));
        let search_changes = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let screen = if settings.tracker.is_empty() { Screen::Settings(SettingsForm::new(&settings, window, cx)) } else { Screen::List };
        PearTube {
            settings,
            status: None,
            entries: Vec::new(),
            error: None,
            screen,
            search,
            bank: Bank { selected: soundfont::path().is_some(), busy: false, error: None, task: None },
            start: None,
            player_events: None,
            _worker: cx.spawn(async move |this, cx| follow(this, cx).await),
            _search: search_changes,
        }
    }

    pub fn start(&mut self, settings: Settings, cx: &mut Context<Self>) {
        self.start = Some(cx.spawn(async move |this, cx| {
            let started = match worker() {
                Ok(w) => w.start(&settings).await.map(drop),
                Err(err) => Err(err),
            };
            match started {
                Ok(()) => refresh(&this, cx).await,
                Err(err) => {
                    let _ = this.update(cx, |this, cx| this.fail(err, cx));
                }
            }
        }));
    }

    fn fail(&mut self, error: String, cx: &mut Context<Self>) {
        self.error = Some(error.into());
        cx.notify();
    }

    pub fn clear_cache(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.clear_cache(key.as_deref()).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
    }

    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.screen = Screen::Settings(SettingsForm::new(&self.settings, window, cx));
        cx.notify();
    }

    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::List;
        cx.notify();
    }

    pub fn play(&mut self, entry: Entry, window: &mut Window, cx: &mut Context<Self>) {
        let screen = cx.new(|cx| PlayScreen::new(entry, window, cx));
        self.player_events = Some(cx.subscribe_in(&screen, window, |this, _, event: &PlayEvent, window, cx| match event {
            PlayEvent::Back => this.close_player(window, cx),
        }));
        self.screen = Screen::Play(screen);
        cx.notify();
    }

    /// Back to the list. The window is opaque again before the play screen,
    /// and with it the picture under the window, goes away.
    fn close_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        self.player_events = None;
        self.show_list(cx);
    }
}

/// Starts the worker with the saved settings, then refreshes the list on
/// every burst of updates from it.
async fn follow(this: WeakEntity<PearTube>, cx: &mut AsyncApp) {
    let w = match worker() {
        Ok(w) => w,
        Err(err) => {
            let _ = this.update(cx, |this, cx| this.fail(err, cx));
            return;
        }
    };
    // Subscribe first, so no update after the start is missed.
    let mut events = w.subscribe();
    let _ = this.update(cx, |this, cx| {
        if !this.settings.tracker.is_empty() {
            this.start(this.settings.clone(), cx);
        }
    });
    while let Some(mut event) = events.next().await {
        // A burst of events costs one refresh.
        loop {
            match event {
                Event::Update => {}
                Event::Fatal(msg) => {
                    let _ = this.update(cx, |this, cx| this.fail(msg, cx));
                }
                Event::Exited => {
                    let _ = this.update(cx, |this, cx| this.fail("The P2P worker stopped".into(), cx));
                    return;
                }
            }
            match events.try_recv() {
                Ok(next) => event = next,
                Err(_) => break,
            }
        }
        refresh(&this, cx).await;
    }
}

async fn refresh(this: &WeakEntity<PearTube>, cx: &mut AsyncApp) {
    let Ok(w) = worker() else { return };
    if !this.read_with(cx, |this, _| !this.settings.tracker.is_empty()).unwrap_or(false) {
        return;
    }
    let result = futures_util::join!(w.status(), w.search(None));
    let _ = this.update(cx, |this, cx| {
        match result {
            (Ok(status), Ok(entries)) => {
                this.status = Some(status);
                this.entries = entries;
            }
            (Err(err), _) | (_, Err(err)) => this.error = Some(err.into()),
        }
        cx.notify();
    });
}

impl Render for PearTube {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let screen = match &self.screen {
            Screen::List => self.render_list(cx).into_any_element(),
            Screen::Settings(form) => self.render_settings(form, cx).into_any_element(),
            Screen::Play(play) => play.clone().into_any_element(),
        };
        let playing = matches!(self.screen, Screen::Play(_));
        v_flex()
            .size_full()
            .text_color(rgb(INK))
            // The play screen paints its own background, around the picture.
            .when(!playing, |this| this.bg(rgb(BG)))
            .when_some(self.error.clone(), |this, error| {
                // On BG even while playing, when the window is transparent.
                this.child(
                    div().bg(rgb(BG)).p_3().child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_3()
                            .py_1()
                            .rounded_lg()
                            .bg(rgb(0x3b181b))
                            .border_1()
                            .border_color(rgb(0x7f1d1d))
                            .text_color(rgb(0xfca5a5))
                            .text_sm()
                            .child(div().flex_1().child(error))
                            .child(Button::new("dismiss-error").ghost().small().icon(IconName::Close).on_click(cx.listener(|this, _, _, cx| {
                                this.error = None;
                                cx.notify();
                            }))),
                    ),
                )
            })
            .child(div().flex_1().min_h_0().child(screen))
    }
}

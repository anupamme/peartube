//! The play screen: peartube-media's Player on an entry's stream URL, its
//! picture in a native view under the window (video.rs), and the controls
//! over it: back, ±10 s, play/pause, the clock, a seek bar, fullscreen, and
//! audio and subtitle menus. They hide 3 s after the mouse last moved while
//! the video plays. Space plays and pauses, ← and → skip 10 s, F toggles
//! fullscreen, Esc leaves it and then the screen. A click on the picture plays
//! or pauses it; a double click toggles fullscreen.

use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use futures_channel::mpsc::unbounded;
use futures_util::StreamExt;
use futures_util::future::{Either, select};
use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use oxideav_core::RuntimeContext;
use peartube::soundfont;
use peartube::worker::Entry;
use player::{Event, Player, PlayerOptions, State, Track, TrackKind};

use crate::list::{column, format_bytes, label, origin};
use crate::theme::{BG, BRAND, CARD, DANGER, DIM};
use crate::video::VideoView;

const CONTEXT: &str = "Player";
const SKIP: Duration = Duration::from_secs(10);
const SHOW_FOR: Duration = Duration::from_secs(3);
/// The longest a double click on the picture may take.
const DOUBLE_CLICK: Duration = Duration::from_secs(2);

/// Every container and decoder the player can use, built once.
static CODECS: LazyLock<Arc<RuntimeContext>> = LazyLock::new(|| Arc::new(codecs::context()));

actions!(player, [TogglePlay, SkipBack, SkipForward, ToggleFullscreen, Back]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("space", TogglePlay, Some(CONTEXT)),
        KeyBinding::new("left", SkipBack, Some(CONTEXT)),
        KeyBinding::new("right", SkipForward, Some(CONTEXT)),
        KeyBinding::new("f", ToggleFullscreen, Some(CONTEXT)),
        KeyBinding::new("escape", Back, Some(CONTEXT)),
    ]);
}

pub enum PlayEvent {
    Back,
}

pub struct PlayScreen {
    entry: Entry,
    /// The only strong reference: menus hold weak ones, so Drop below decides
    /// where the player is dropped.
    player: Option<Arc<Player>>,
    video: Option<VideoView>,
    /// Why there is no player.
    open_error: Option<SharedString>,
    state: State,
    /// The seek bar, made once the duration is known: 0 to the duration, in seconds.
    seek: Option<(Entity<SliderState>, Subscription)>,
    /// Where the seek bar is while it is dragged, in seconds.
    dragging: Option<f32>,
    /// The controls show until then, and always while paused.
    controls_until: Instant,
    /// The video slot's bounds, last given to the native view.
    frame: Option<Bounds<Pixels>>,
    /// An audio or subtitle menu is open: the controls stay up under it.
    menu_open: bool,
    /// When the picture last took a single click, for telling double clicks.
    clicked_at: Option<Instant>,
    focus: FocusHandle,
    _tick: Task<()>,
}

impl EventEmitter<PlayEvent> for PlayScreen {}

impl Drop for PlayScreen {
    /// Dropping a Player joins its pipeline thread, which may be waiting on
    /// the main queue (AppleBackend makes its audio and subtitle sinks there),
    /// and this runs on the main thread: drop it on its own thread.
    fn drop(&mut self) {
        if let Some(player) = self.player.take() {
            std::thread::spawn(move || drop(player));
        }
    }
}

impl PlayScreen {
    pub fn new(entry: Entry, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, mut events) = unbounded::<Event>();
        let (player, video, open_error) = match VideoView::open(window) {
            Ok(video) => {
                let options = PlayerOptions { soundfont: soundfont::path(), ..PlayerOptions::default() };
                let player = Player::open(&entry.stream_url, video.backend(), CODECS.clone(), options, move |event| {
                    let _ = tx.unbounded_send(event);
                });
                (Some(Arc::new(player)), Some(video), None)
            }
            Err(err) => (None, None, Some(err.into())),
        };
        // Events come on change; the clock needs a steadier beat.
        let tick = cx.spawn_in(window, async move |this, cx| {
            loop {
                let beat = cx.background_executor().timer(Duration::from_millis(250));
                let ended = match select(events.next(), beat).await {
                    Either::Left((None, _)) => return,
                    Either::Left((Some(event), _)) => matches!(event, Event::Ended),
                    Either::Right(_) => false,
                };
                if this.update_in(cx, |this, window, cx| this.tick(ended, window, cx)).is_err() {
                    return;
                }
            }
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        PlayScreen {
            entry,
            player,
            video,
            open_error,
            state: State::default(),
            seek: None,
            dragging: None,
            controls_until: Instant::now() + SHOW_FOR,
            frame: None,
            menu_open: false,
            clicked_at: None,
            focus,
            _tick: tick,
        }
    }

    fn tick(&mut self, ended: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(player) = &self.player else { return };
        self.state = player.state();
        if ended {
            return cx.emit(PlayEvent::Back);
        }
        if let (None, Some(duration)) = (&self.seek, self.state.duration) {
            let seek = cx.new(|_| SliderState::new().min(0.).max(duration.as_secs_f32().max(1.)).step(1.));
            let subscription = cx.subscribe_in(&seek, window, Self::on_seek);
            self.seek = Some((seek, subscription));
        }
        // The seek bar follows the clock, except while it is dragged.
        if let (Some((seek, _)), None) = (&self.seek, self.dragging) {
            let at = self.state.position.as_secs_f32();
            seek.update(cx, |seek, cx| {
                if seek.value().start() != at {
                    seek.set_value(at, window, cx);
                }
            });
        }
        cx.notify();
    }

    fn on_seek(&mut self, _: &Entity<SliderState>, event: &SliderEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.poke(cx);
        match event {
            SliderEvent::Change(at) => self.dragging = Some(at.start()),
            SliderEvent::Release(at) => {
                self.dragging = None;
                if let Some(player) = &self.player {
                    player.seek(Duration::from_secs_f32(at.start().max(0.)));
                }
            }
        }
        cx.notify();
    }

    /// Shows the controls for a while.
    fn poke(&mut self, cx: &mut Context<Self>) {
        let hidden = !self.controls_shown();
        self.controls_until = Instant::now() + SHOW_FOR;
        if hidden {
            cx.notify();
        }
    }

    fn controls_shown(&self) -> bool {
        self.menu_open || self.dragging.is_some() || !self.state.playing || Instant::now() < self.controls_until
    }

    /// A click on the picture plays or pauses it; a double click toggles
    /// fullscreen and undoes its first click. AppKit counts a double click
    /// wherever its first click landed (a list row, say), so it counts as one
    /// here only if the picture took that first click.
    fn click(&mut self, count: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        match count {
            1 => {
                self.clicked_at = Some(Instant::now());
                self.toggle_play(cx);
            }
            2 if self.clicked_at.take().is_some_and(|at| at.elapsed() < DOUBLE_CLICK) => {
                window.toggle_fullscreen();
                self.toggle_play(cx);
            }
            _ => {}
        }
    }

    fn toggle_play(&mut self, cx: &mut Context<Self>) {
        self.poke(cx);
        let Some(player) = &self.player else { return };
        if player.state().playing { player.pause() } else { player.play() }
        self.state = player.state();
        cx.notify();
    }

    fn skip(&mut self, forward: bool, cx: &mut Context<Self>) {
        self.poke(cx);
        let (Some(player), Some(duration)) = (&self.player, self.state.duration) else { return };
        let at = if forward { (self.state.position + SKIP).min(duration) } else { self.state.position.saturating_sub(SKIP) };
        player.seek(at);
    }

    /// Esc and the back button leave fullscreen first, then the screen.
    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        } else {
            cx.emit(PlayEvent::Back);
        }
    }

    /// Keeps the native picture under the video slot. The window turns
    /// transparent only once the picture is there to show through.
    fn place(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        if self.frame == Some(bounds) {
            return;
        }
        self.frame = Some(bounds);
        if let Some(video) = &self.video {
            let [x, y, w, h] = [bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height].map(|p| f64::from(f32::from(p)));
            video.set_frame([x, y, w, h]);
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
        }
    }

    /// A menu of the audio or subtitle tracks on `button`, when there is a choice.
    fn track_menu(&self, kind: TrackKind, button: Button, anchor: Anchor, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let player = Arc::downgrade(self.player.as_ref()?);
        let tracks: Vec<Track> = self.state.tracks.iter().filter(|t| t.kind == kind).cloned().collect();
        let current = if kind == TrackKind::Audio { self.state.audio } else { self.state.subtitle };
        // One audio track needs no menu; subtitles always have "Off".
        let mut items: Vec<(String, Option<u32>, bool)> = Vec::new();
        match kind {
            TrackKind::Audio if tracks.len() < 2 => return None,
            TrackKind::Subtitle if tracks.is_empty() => return None,
            TrackKind::Subtitle => items.push(("Off".into(), None, current.is_none())),
            _ => {}
        }
        items.extend(tracks.iter().map(|t| (track_label(t), Some(t.stream), current == Some(t.stream))));
        let this = cx.entity().downgrade();
        let menu = button.dropdown_menu(move |menu, _, _| {
            items.iter().fold(menu, |menu, (label, stream, selected)| {
                let (player, stream) = (player.clone(), *stream);
                menu.item(PopupMenuItem::new(label.clone()).checked(*selected).on_click(move |_, _, _| {
                    let Some(player) = player.upgrade() else { return };
                    if kind == TrackKind::Audio { player.select_audio(stream) } else { player.select_subtitle(stream) }
                }))
            })
        });
        Some(menu.anchor(anchor).on_open_change(move |open, _, cx| {
            let _ = this.update(cx, |this, cx| {
                this.menu_open = *open;
                this.controls_until = Instant::now() + SHOW_FOR;
                cx.notify();
            });
        }))
    }

    fn render_controls(&self, fullscreen: bool, clock: String, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.state.buffering && self.state.error.is_none();
        let shade = |angle: f32, alpha: f32| linear_gradient(angle, linear_color_stop(hsla(0., 0., 0., alpha), 0.), linear_color_stop(hsla(0., 0., 0., 0.), 1.));
        let overlay_button = |id: &'static str, icon: Icon, tooltip: &'static str| Button::new(id).ghost().icon(icon).tooltip(tooltip);
        v_flex()
            .absolute()
            .inset_0()
            .justify_between()
            .text_color(white())
            .child(
                fenced(h_flex())
                    .w_full()
                    .gap_1()
                    .p_2()
                    .bg(shade(180., 0.6))
                    .child(overlay_button("back", IconName::ArrowLeft.into(), "Back").on_click(cx.listener(|this, _, window, cx| this.back(window, cx))))
                    .when(fullscreen, |this| {
                        // Up against the right edge: the menus open to the left.
                        let subtitles = self.track_menu(TrackKind::Subtitle, overlay_button("cc", Lucide::Captions.into(), "Subtitles"), Anchor::TopRight, cx);
                        let audio = self.track_menu(TrackKind::Audio, overlay_button("audio", Lucide::Volume2.into(), "Audio"), Anchor::TopRight, cx);
                        this.child(div().flex_1().ml_2().truncate().font_weight(FontWeight::SEMIBOLD).child(self.entry.title.clone()))
                            .children(subtitles)
                            .children(audio)
                    }),
            )
            .child(
                h_flex()
                    .justify_center()
                    .gap_12()
                    .child(fenced(div()).child(
                        overlay_button("skip-back", Lucide::RotateCcw.into(), "Back 10 seconds")
                            .with_size(px(48.))
                            .on_click(cx.listener(|this, _, _, cx| this.skip(false, cx))),
                    ))
                    .child(if busy {
                        // The spinner shows here.
                        div().size(px(60.)).into_any_element()
                    } else {
                        let (icon, tooltip) = if self.state.playing { (IconName::Pause, "Pause") } else { (IconName::Play, "Play") };
                        fenced(div())
                            .child(
                                overlay_button("play", icon.into(), tooltip)
                                    .with_size(px(60.))
                                    .rounded(px(30.))
                                    .bg(hsla(0., 0., 0., 0.35))
                                    .on_click(cx.listener(|this, _, _, cx| this.toggle_play(cx))),
                            )
                            .into_any_element()
                    })
                    .child(fenced(div()).child(
                        overlay_button("skip-forward", IconName::RotateCw.into(), "Forward 10 seconds")
                            .with_size(px(48.))
                            .on_click(cx.listener(|this, _, _, cx| this.skip(true, cx))),
                    )),
            )
            .child(
                fenced(v_flex())
                    .w_full()
                    .px_3()
                    .pb_2()
                    .bg(shade(0., 0.75))
                    .child(
                        h_flex()
                            .child(div().flex_1().ml_1().text_sm().child(clock))
                            .child(
                                overlay_button("fullscreen", if fullscreen { IconName::Minimize } else { IconName::Maximize }.into(), if fullscreen { "Exit fullscreen" } else { "Fullscreen" })
                                    .on_click(cx.listener(|_, _, window, _| window.toggle_fullscreen())),
                            ),
                    )
                    .child(div().h(px(20.)).flex().items_center().children(self.seek.as_ref().map(|(seek, _)| {
                        Slider::new(seek).bg(rgb(BRAND)).text_color(white())
                    }))),
            )
    }

    fn render_details(&self, error: Option<SharedString>, cx: &mut Context<Self>) -> impl IntoElement {
        let sha = self.entry.sha256.get(..16).unwrap_or(&self.entry.sha256);
        let cached_note = if !self.entry.local && self.entry.cached_bytes > 0 {
            format!(" · cached {}", format_bytes(self.entry.cached_bytes))
        } else {
            String::new()
        };
        div().bg(rgb(BG)).child(
            column()
                .py_4()
                .gap_1()
                .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).truncate().child(self.entry.title.clone()))
                .child(div().text_sm().text_color(rgb(DIM)).child(format!("{} · {} · {}{cached_note}", label(&self.entry.id), format_bytes(self.entry.size), origin(&self.entry))))
                .children({
                    let menus: Vec<_> = [
                        self.track_menu(TrackKind::Audio, chip("audio-chip", Lucide::Volume2.into(), self.track_name(TrackKind::Audio)), Anchor::TopLeft, cx),
                        self.track_menu(TrackKind::Subtitle, chip("subtitles-chip", Lucide::Captions.into(), self.track_name(TrackKind::Subtitle)), Anchor::TopLeft, cx),
                    ]
                    .into_iter()
                    .flatten()
                    .collect();
                    (!menus.is_empty()).then(|| h_flex().mt_3().gap_2().children(menus))
                })
                .when_some(error, |this, error| {
                    this.child(div().mt_3().p_3().rounded_lg().bg(rgb(CARD)).text_sm().text_color(rgb(DANGER)).child(error))
                })
                .child(div().mt_4().text_xs().text_color(rgb(DIM)).child(format!("SHA-256 {sha}…"))),
        )
    }

    fn track_name(&self, kind: TrackKind) -> String {
        let current = if kind == TrackKind::Audio { self.state.audio } else { self.state.subtitle };
        let name = self.state.tracks.iter().find(|t| t.kind == kind && Some(t.stream) == current).map(short_name);
        match kind {
            TrackKind::Audio => name.unwrap_or_else(|| "No audio".into()),
            _ => name.unwrap_or_else(|| "Off".into()),
        }
    }
}

impl Render for PlayScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fullscreen = window.is_fullscreen();
        let st = &self.state;
        let shown = self.dragging.map(Duration::from_secs_f32).unwrap_or(st.position);
        let clock = match st.duration {
            Some(duration) => format!("{} / {}", clock(shown), clock(duration)),
            None if st.buffering || st.position.is_zero() => "Loading…".into(),
            None => clock(st.position),
        };
        let busy = st.buffering && st.error.is_none();
        let error = self.open_error.clone().or_else(|| st.error.clone().map(Into::into));
        let (placer, mover) = (cx.entity().downgrade(), cx.entity().downgrade());

        let slot = div()
            .id("video")
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            // Nothing paints here but the controls: the picture is under the window.
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let _ = placer.update(cx, |this, _| this.place(bounds, window));
                    },
                    // A move over the picture shows the controls. Listening on
                    // the window, not the slot, also hears moves over an open
                    // menu, which keeps the mouse from the elements under it.
                    move |bounds, _, window, _| {
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase == DispatchPhase::Bubble && bounds.contains(&event.position) {
                                let _ = mover.update(cx, |this, cx| this.poke(cx));
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| this.click(event.click_count(), window, cx)))
            .when(busy, |this| this.child(div().absolute().inset_0().flex().items_center().justify_center().child(Spinner::new().large().color(white()))))
            .when(fullscreen, |this| {
                this.when_some(error.clone(), |this, error| {
                    this.child(div().absolute().inset_0().flex().items_center().justify_center().child(div().p_3().rounded_lg().bg(rgb(CARD)).text_color(rgb(DANGER)).child(error)))
                })
            })
            .when(self.controls_shown(), |this| this.child(self.render_controls(fullscreen, clock, cx)));

        v_flex()
            .size_full()
            .track_focus(&self.focus)
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &TogglePlay, _, cx| this.toggle_play(cx)))
            .on_action(cx.listener(|this, _: &SkipBack, _, cx| this.skip(false, cx)))
            .on_action(cx.listener(|this, _: &SkipForward, _, cx| this.skip(true, cx)))
            .on_action(cx.listener(|_, _: &ToggleFullscreen, window, _| window.toggle_fullscreen()))
            .on_action(cx.listener(|this, _: &Back, window, cx| this.back(window, cx)))
            .child(slot)
            .when(!fullscreen, |this| this.child(self.render_details(error, cx)))
    }
}

/// Clicks inside `element` stay there: the picture under the controls plays
/// and pauses on a click, and gpui-component's buttons and slider let the
/// mouse-down through.
fn fenced(element: Div) -> Div {
    element.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

fn chip(id: &'static str, icon: Icon, text: String) -> Button {
    Button::new(id).small().icon(icon).label(text)
}

fn clock(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

fn track_label(t: &Track) -> String {
    let mut label = t.title.clone().or_else(|| t.language.clone()).unwrap_or_else(|| format!("Track {}", t.stream));
    if t.title.is_some() {
        if let Some(lang) = &t.language {
            label = format!("{label} ({lang})");
        }
    }
    format!("{label} · {}", t.codec)
}

fn short_name(t: &Track) -> String {
    t.title.clone().or_else(|| t.language.as_ref().map(|l| l.to_uppercase())).unwrap_or_else(|| format!("Track {}", t.stream))
}

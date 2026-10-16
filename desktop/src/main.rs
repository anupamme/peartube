//! PearTube for the Mac: a GPUI window over the P2P worklet (peartube::worker)
//! and peartube-media's player. It joins a tracker, lists its entries grouped
//! by title, and plays one in the window.

mod app;
mod list;
mod play;
mod settings_screen;
mod theme;
mod video;

use std::borrow::Cow;

use gpui_kit::assets::{Assets, icon_assets};
use gpui_kit::base::Root;
use gpui_kit::*;

actions!(peartube, [Quit]);

// The player's icons that gpui-component's own set lacks.
icon_assets!(PlayerIcons, [Captions, Volume2, RotateCcw]);

/// gpui-component's icons plus the player's.
struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match PlayerIcons.load(path)? {
            Some(svg) => Ok(Some(svg)),
            None => Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = Assets.list(path)?;
        paths.extend(PlayerIcons.list(path)?);
        Ok(paths)
    }
}

fn main() {
    gpui_kit::application().with_assets(AppAssets).run(|cx: &mut App| {
        gpui_kit::init(cx);
        theme::apply(cx);
        play::bind_keys(cx);
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus([Menu { name: "PearTube".into(), items: vec![MenuItem::action("Quit PearTube", Quit)], disabled: false }]);
        // One window; closing it quits, and with it the worklet.
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1000.), px(680.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some("PearTube".into()), appears_transparent: false, traffic_light_position: None }),
            window_min_size: Some(size(px(480.), px(360.))),
            app_id: Some("com.peartube.app".into()),
            ..Default::default()
        };
        cx.open_window(options, |window, cx| {
            let view = cx.new(|cx| app::PearTube::new(window, cx));
            // gpui-component's Root paints the theme's background over the whole
            // window; the views paint their own, so the play screen can leave
            // its video slot clear for the picture under it (video.rs).
            cx.new(|cx| Root::new(view, window, cx).bg(transparent_black()))
        })
        .expect("open the window");
        cx.activate(true);
    });
}

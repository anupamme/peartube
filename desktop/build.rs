//! Packs worklet/worker.js for this Mac and links bare-kit, which runs it.
//! Needs `npm ci` at the repo root and `sh worklet/bare-kit.sh darwin` once.
//! The Android app (android/) packs the same worker with android/worklet.mjs.
//!
//! bare-kit only loads linked addons, so the worker's native addons are
//! linked with bare-link into target/bare-addons/<host> as frameworks, and the
//! bundle loads them by name. The binary finds them, and BareKit, through its
//! rpaths: in place for `cargo run`, and in Contents/Frameworks once
//! desktop/bundle.sh has copied them into PearTube.app.
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let worklet = root.join("worklet");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());

    for path in ["worker.js", "build.mjs", "pack.cjs", "imports.json", "crypto", "vendor/bare-kit"] {
        println!("cargo:rerun-if-changed={}", worklet.join(path).display());
    }
    for path in ["src", "patches", "package.json", "package-lock.json"] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }

    let host = match (env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(), env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str()) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        target => panic!("PearTube's desktop app builds for macOS only, not {target:?}"),
    };
    // Pack and link one entry graph with identical builtin overrides.
    let bundle = out.join("worker.bundle");
    let addons = manifest.join("target/bare-addons").join(host);
    run(Command::new("node")
        .arg(worklet.join("build.mjs"))
        .arg(host)
        .arg(&bundle)
        .arg(&addons)
        .current_dir(root));

    let kit = worklet.join("vendor/bare-kit/darwin");
    if !kit.join("BareKit.framework").exists() {
        panic!("bare-kit is not built for macOS: run `sh worklet/bare-kit.sh darwin`");
    }
    println!("cargo:rustc-link-search=framework={}", kit.display());
    println!("cargo:rustc-link-lib=framework=BareKit");
    for rpath in [kit.display().to_string(), addons.display().to_string(), "@executable_path/../Frameworks".into()] {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
    }
}

fn run(command: &mut Command) {
    let status = command.status().unwrap_or_else(|err| panic!("{command:?}: {err}"));
    assert!(status.success(), "{command:?} failed: {status}");
}

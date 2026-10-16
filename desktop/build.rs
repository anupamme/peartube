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
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let worklet = root.join("worklet");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());

    for path in ["worker.js", "pack.cjs", "imports.json", "crypto", "vendor/bare-kit"] {
        println!("cargo:rerun-if-changed={}", worklet.join(path).display());
    }
    for path in ["src", "package.json", "package-lock.json"] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }

    let host = match (env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(), env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str()) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        target => panic!("PearTube's desktop app builds for macOS only, not {target:?}"),
    };
    // imports.json maps the Node builtins that LAN discovery's mDNS dependencies
    // require (dgram, os, ...) to their bare-* modules. Bare starts from its
    // launcher script: bare, bare-runtime and its platform package all claim
    // the `bare` bin, and npm 10 then links none of them.
    let bundle = out.join("worker.bundle");
    run(Command::new("node")
        .arg(root.join("node_modules/bare/bin/bare"))
        .arg(worklet.join("pack.cjs"))
        .args(["--linked", "--host", host, "--imports"])
        .arg(worklet.join("imports.json"))
        .arg("--out")
        .arg(&bundle)
        .arg(worklet.join("worker.js"))
        .current_dir(root));
    let addons = manifest.join("target/bare-addons").join(host);
    link_addons(root, &bundle, host, &addons);

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

/// bare-link every addon the bundle loads. The bundle header maps each
/// addon's binding.js, at its package root, to a `linked:` library.
fn link_addons(root: &Path, bundle: &Path, host: &str, out: &Path) {
    // "<len>\n<json>\n", where len counts both newlines.
    let bytes = std::fs::read(bundle).unwrap();
    let newline = bytes.iter().position(|&b| b == b'\n').unwrap();
    let len: usize = std::str::from_utf8(&bytes[..newline]).unwrap().parse().unwrap();
    let header: serde_json::Value = serde_json::from_slice(&bytes[newline..newline + len]).unwrap();
    let _ = std::fs::remove_dir_all(out);
    for (file, imports) in header["resolutions"].as_object().unwrap() {
        let linked = imports["."]["addon"].as_str().is_some_and(|addon| addon.starts_with("linked:"));
        if linked {
            let package = root.join(Path::new(file.trim_start_matches('/')).parent().unwrap());
            run(Command::new("node").arg(root.join("node_modules/bare-link/bin.js")).args(["--host", host, "--out"]).arg(out).arg(package));
        }
    }
}

fn run(command: &mut Command) {
    let status = command.status().unwrap_or_else(|err| panic!("{command:?}: {err}"));
    assert!(status.success(), "{command:?} failed: {status}");
}

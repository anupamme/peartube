//! PearTube Browser WebAssembly Media Engine.
//! Wraps peartube-media's safe-Rust container demuxers, video/audio/subtitle decoders,
//! surround-to-stereo downmixer, and zero-reencode fMP4 muxer behind a flat C ABI for Web Workers.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::LazyLock;

use oxideav_core::{
    ChannelLayout, ChannelPosition, Decoder, Demuxer, Error as AvError, Frame,
    MediaType, Packet, PixelFormat, ProbeData, RuntimeContext, SampleFormat, Segment, StreamInfo,
    SubtitleCue, TimeBase, VideoFrame, PROBE_SCORE_EXTENSION,
};
use oxideav_pixfmt::{ConvertOptions, FrameInfo};
use serde_json::json;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_stream_len() -> u64;
    fn host_read_at(offset: u64, dst: *mut u8, len: usize) -> isize;
}

const PAGE_SIZE: usize = 512 * 1024;
const MAX_PAGES: usize = 32; // 16 MiB sliding LRU block cache aligned to 512 KiB Hyperblobs blocks
const VIDEO_TIMESCALE: u32 = 90_000;

static REGISTRY: LazyLock<RuntimeContext> = LazyLock::new(codecs::context);

struct CachePage {
    index: u64,
    stamp: u64,
    data: Vec<u8>,
}

// Sucks 512 KiB HTTP Range blocks on demand into an LRU ring so 20+ GB Blu-ray MKVs seek in milliseconds.
struct HttpRangeSource {
    len: u64,
    pos: u64,
    clock: u64,
    pages: Vec<CachePage>,
}

impl HttpRangeSource {
    fn new() -> Self {
        let len = unsafe { host_stream_len() };
        Self {
            len,
            pos: 0,
            clock: 0,
            pages: Vec::with_capacity(MAX_PAGES),
        }
    }

    fn fetch_page(&mut self, page_index: u64) -> io::Result<usize> {
        self.clock = self.clock.wrapping_add(1);
        if let Some(idx) = self.pages.iter().position(|p| p.index == page_index) {
            self.pages[idx].stamp = self.clock;
            return Ok(idx);
        }
        let start = page_index.saturating_mul(PAGE_SIZE as u64);
        if start >= self.len {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "past stream end"));
        }
        let want = (self.len - start).min(PAGE_SIZE as u64) as usize;
        let mut buf = vec![0u8; want];
        let mut filled = 0usize;
        while filled < want {
            let got = unsafe {
                host_read_at(
                    start + filled as u64,
                    buf[filled..].as_mut_ptr(),
                    want - filled,
                )
            };
            if got < 0 {
                return Err(io::Error::other("HTTP Range read failed"));
            }
            if got == 0 {
                break;
            }
            filled += got as usize;
        }
        buf.truncate(filled);
        if filled == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "empty Range response"));
        }
        if self.pages.len() >= MAX_PAGES {
            let lru = self
                .pages
                .iter()
                .enumerate()
                .min_by_key(|(_, p)| p.stamp)
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.pages[lru] = CachePage {
                index: page_index,
                stamp: self.clock,
                data: buf,
            };
            Ok(lru)
        } else {
            let idx = self.pages.len();
            self.pages.push(CachePage {
                index: page_index,
                stamp: self.clock,
                data: buf,
            });
            Ok(idx)
        }
    }
}

impl Read for HttpRangeSource {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let page_index = self.pos / PAGE_SIZE as u64;
        let page_off = (self.pos % PAGE_SIZE as u64) as usize;
        let slot = match self.fetch_page(page_index) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(0),
            Err(e) => return Err(e),
        };
        let page = &self.pages[slot].data;
        if page_off >= page.len() {
            return Ok(0);
        }
        let n = out.len().min(page.len() - page_off);
        out[..n].copy_from_slice(&page[page_off..page_off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeSource {
    fn seek(&mut self, style: SeekFrom) -> io::Result<u64> {
        let next: i128 = match style {
            SeekFrom::Start(off) => i128::from(off),
            SeekFrom::Current(rel) => i128::from(self.pos) + i128::from(rel),
            SeekFrom::End(rel) => i128::from(self.len) + i128::from(rel),
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek"));
        }
        self.pos = (next as u64).min(self.len);
        Ok(self.pos)
    }
}

// Folds 5.1 / 7.1 surround channels down to hot stereo without losing center-channel dialogue or clipping.
struct StereoMix {
    channels: usize,
    gains: [[f32; 2]; 64],
}

impl StereoMix {
    fn new(layout: ChannelLayout) -> Self {
        let channels = usize::from(layout.channel_count()).clamp(1, 64);
        let mut gains = [[0.0f32; 2]; 64];
        let surround = std::f32::consts::FRAC_1_SQRT_2;
        for (idx, gain) in gains[..channels].iter_mut().enumerate() {
            use ChannelPosition::*;
            *gain = match layout.position(idx) {
                Some(FrontLeft) => [1.0, 0.0],
                Some(FrontRight) => [0.0, 1.0],
                Some(FrontCenter) if channels == 1 => [1.0, 1.0],
                Some(FrontCenter) => [surround, surround],
                Some(SideLeft | BackLeft | FrontLeftOfCenter) => [surround, 0.0],
                Some(SideRight | BackRight | FrontRightOfCenter) => [0.0, surround],
                Some(BackCenter) => [0.5, 0.5],
                Some(LowFrequency) => [0.0, 0.0],
                _ => [1.0 / channels as f32; 2],
            };
        }
        let mut sums = [0.0f32; 2];
        for g in &gains[..channels] {
            sums[0] += g[0];
            sums[1] += g[1];
        }
        let scale = 1.0 / sums[0].max(sums[1]).max(1.0);
        for g in &mut gains[..channels] {
            g[0] *= scale;
            g[1] *= scale;
        }
        Self { channels, gains }
    }

    fn mix(&self, pcm: &[f32]) -> Vec<f32> {
        let frames = pcm.len() / self.channels.max(1);
        let mut out = Vec::with_capacity(frames * 2);
        for input in pcm.chunks_exact(self.channels.max(1)) {
            let mut l = 0.0f32;
            let mut r = 0.0f32;
            for (&s, g) in input.iter().zip(&self.gains) {
                let sample = if s.is_finite() { s } else { 0.0 };
                l += sample * g[0];
                r += sample * g[1];
            }
            out.push(l.clamp(-1.0, 1.0));
            out.push(r.clamp(-1.0, 1.0));
        }
        out
    }
}

fn convert_audio_to_f32(af: &oxideav_core::AudioFrame, format: SampleFormat, channels: usize) -> Vec<f32> {
    let n = af.samples as usize;
    let mut out = Vec::with_capacity(n * channels);
    for i in 0..n {
        for c in 0..channels {
            out.push(sample_f32(format, &af.data, channels, c, i));
        }
    }
    out
}

fn sample_f32(format: SampleFormat, data: &[Vec<u8>], channels: usize, c: usize, i: usize) -> f32 {
    let (plane, index) = if format.is_planar() {
        (data.get(c).or_else(|| data.first()).map(Vec::as_slice).unwrap_or(&[]), i)
    } else {
        (data.first().map(Vec::as_slice).unwrap_or(&[]), i * channels + c)
    };
    let w = format.bytes_per_sample();
    let start = index * w;
    if w == 0 || start + w > plane.len() {
        return 0.0;
    }
    let b = &plane[start..start + w];
    match format {
        SampleFormat::U8 | SampleFormat::U8P => (b[0] as f32 - 128.0) / 128.0,
        SampleFormat::S8 => (b[0] as i8 as f32) / 128.0,
        SampleFormat::S16 | SampleFormat::S16P => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
        SampleFormat::S24 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        SampleFormat::S32 | SampleFormat::S32P => {
            i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0
        }
        SampleFormat::F32 | SampleFormat::F32P => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        SampleFormat::F64 | SampleFormat::F64P => {
            f64::from_le_bytes(b.try_into().unwrap_or([0; 8])) as f32
        }
        _ => 0.0,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VideoCodecKind {
    H264,
    Hevc,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NalFraming {
    AnnexB,
    LengthPrefixed(u8),
}

#[derive(Clone)]
struct MseVideoConfig {
    kind: VideoCodecKind,
    width: u32,
    height: u32,
    framing: NalFraming,
    record_4byte: Vec<u8>,
    codec_string: String,
    frame_ticks_90k: i64,
}

fn split_annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0usize;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (idx, &s) in starts.iter().enumerate() {
        let nal_start = s + 3;
        let mut nal_end = starts.get(idx + 1).copied().unwrap_or(data.len());
        while nal_end > nal_start && data[nal_end - 1] == 0 {
            nal_end -= 1;
        }
        if nal_end > nal_start {
            out.push(&data[nal_start..nal_end]);
        }
    }
    out
}

fn to_4byte_nals(data: &[u8], framing: NalFraming) -> Vec<u8> {
    match framing {
        NalFraming::LengthPrefixed(4) => data.to_vec(),
        NalFraming::LengthPrefixed(w) => {
            let width = w as usize;
            let mut out = Vec::with_capacity(data.len() + 16);
            let mut pos = 0usize;
            while pos + width <= data.len() {
                let mut len = 0usize;
                for &b in &data[pos..pos + width] {
                    len = (len << 8) | (b as usize);
                }
                pos += width;
                if len == 0 || pos + len > data.len() {
                    break;
                }
                out.extend_from_slice(&(len as u32).to_be_bytes());
                out.extend_from_slice(&data[pos..pos + len]);
                pos += len;
            }
            out
        }
        NalFraming::AnnexB => {
            let mut out = Vec::with_capacity(data.len() + 16);
            for nal in split_annexb_nals(data) {
                out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                out.extend_from_slice(nal);
            }
            out
        }
    }
}

fn probe_mse_video(stream: &StreamInfo, first_keyframe: Option<&[u8]>) -> Option<MseVideoConfig> {
    let params = &stream.params;
    let w = params.width.unwrap_or(0);
    let h = params.height.unwrap_or(0);
    if w == 0 || h == 0 {
        return None;
    }
    let fps = params
        .frame_rate
        .map(|r| if r.den > 0 { r.num as f64 / r.den as f64 } else { 0.0 })
        .filter(|&f| f > 1.0 && f < 240.0)
        .unwrap_or(24.0);
    let frame_ticks_90k = ((VIDEO_TIMESCALE as f64) / fps).round().max(1.0) as i64;
    let extra = &params.extradata;

    match params.codec_id.as_str() {
        "h264" => {
            if extra.len() >= 7 && extra[0] == 1 {
                let len_size = (extra[4] & 3) + 1;
                let mut rec = extra.clone();
                rec[4] |= 0x03; // declare 4-byte NAL lengths in avcC
                let codec_string = format!("avc1.{:02x}{:02x}{:02x}", extra[1], extra[2], extra[3]);
                Some(MseVideoConfig {
                    kind: VideoCodecKind::H264,
                    width: w,
                    height: h,
                    framing: NalFraming::LengthPrefixed(len_size),
                    record_4byte: rec,
                    codec_string,
                    frame_ticks_90k,
                })
            } else {
                let mut sps: Option<Vec<u8>> = None;
                let mut pps: Option<Vec<u8>> = None;
                for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
                    for nal in split_annexb_nals(src) {
                        match nal[0] & 0x1F {
                            7 if nal.len() >= 4 && sps.is_none() => sps = Some(nal.to_vec()),
                            8 if pps.is_none() => pps = Some(nal.to_vec()),
                            _ => {}
                        }
                    }
                }
                let (sps, pps) = (sps?, pps?);
                let codec_string = format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
                let mut rec = Vec::with_capacity(11 + sps.len() + pps.len());
                rec.extend_from_slice(&[1, sps[1], sps[2], sps[3], 0xFF, 0xE1]);
                rec.extend_from_slice(&(sps.len() as u16).to_be_bytes());
                rec.extend_from_slice(&sps);
                rec.push(1);
                rec.extend_from_slice(&(pps.len() as u16).to_be_bytes());
                rec.extend_from_slice(&pps);
                Some(MseVideoConfig {
                    kind: VideoCodecKind::H264,
                    width: w,
                    height: h,
                    framing: NalFraming::AnnexB,
                    record_4byte: rec,
                    codec_string,
                    frame_ticks_90k,
                })
            }
        }
        "h265" | "hevc" => {
            if extra.len() >= 23 && extra[0] == 1 {
                let len_size = (extra[21] & 3) + 1;
                let mut rec = extra.clone();
                rec[21] |= 0x03; // declare 4-byte NAL lengths in hvcC
                let space = match (extra[1] >> 6) & 3 {
                    1 => "A",
                    2 => "B",
                    3 => "C",
                    _ => "",
                };
                let tier = if (extra[1] & 0x20) != 0 { "H" } else { "L" };
                let profile = extra[1] & 0x1F;
                let compat = u32::from_be_bytes([extra[2], extra[3], extra[4], extra[5]]).reverse_bits();
                let level = extra[12];
                let mut constraints = &extra[6..12];
                while let Some((&0, rest)) = constraints.split_last() {
                    constraints = rest;
                }
                let mut codec_string = format!("hvc1.{space}{profile}.{compat:x}.{tier}{level}");
                for &b in constraints {
                    codec_string.push_str(&format!(".{b:X}"));
                }
                Some(MseVideoConfig {
                    kind: VideoCodecKind::Hevc,
                    width: w,
                    height: h,
                    framing: NalFraming::LengthPrefixed(len_size),
                    record_4byte: rec,
                    codec_string,
                    frame_ticks_90k,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

fn wrap_box(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(fourcc);
    out.extend_from_slice(payload);
    out
}

fn build_fmp4_init(cfg: &MseVideoConfig) -> Vec<u8> {
    let mut ftyp_body = Vec::with_capacity(24);
    ftyp_body.extend_from_slice(b"iso6");
    ftyp_body.extend_from_slice(&1u32.to_be_bytes());
    ftyp_body.extend_from_slice(b"iso6cmfciso5mp41");
    let ftyp = wrap_box(b"ftyp", &ftyp_body);

    let mut mvhd = Vec::with_capacity(96);
    mvhd.extend_from_slice(&[0u8; 12]);
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&0u32.to_be_bytes());
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes());
    mvhd.extend_from_slice(&[0u8; 10]);
    for m in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        mvhd.extend_from_slice(&m.to_be_bytes());
    }
    mvhd.extend_from_slice(&[0u8; 24]);
    mvhd.extend_from_slice(&2u32.to_be_bytes());

    let mut tkhd = Vec::with_capacity(84);
    tkhd.extend_from_slice(&[0, 0, 0, 3]);
    tkhd.extend_from_slice(&[0u8; 8]);
    tkhd.extend_from_slice(&1u32.to_be_bytes());
    tkhd.extend_from_slice(&[0u8; 24]);
    for m in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        tkhd.extend_from_slice(&m.to_be_bytes());
    }
    tkhd.extend_from_slice(&(cfg.width << 16).to_be_bytes());
    tkhd.extend_from_slice(&(cfg.height << 16).to_be_bytes());

    let (sample_fourcc, cfg_fourcc) = match cfg.kind {
        VideoCodecKind::H264 => (b"avc1", b"avcC"),
        VideoCodecKind::Hevc => (b"hvc1", b"hvcC"),
    };
    let mut vse = Vec::with_capacity(86 + cfg.record_4byte.len());
    vse.extend_from_slice(&[0u8; 6]);
    vse.extend_from_slice(&1u16.to_be_bytes());
    vse.extend_from_slice(&[0u8; 16]);
    vse.extend_from_slice(&(cfg.width as u16).to_be_bytes());
    vse.extend_from_slice(&(cfg.height as u16).to_be_bytes());
    vse.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    vse.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    vse.extend_from_slice(&0u32.to_be_bytes());
    vse.extend_from_slice(&1u16.to_be_bytes());
    vse.extend_from_slice(&[0u8; 32]);
    vse.extend_from_slice(&0x0018u16.to_be_bytes());
    vse.extend_from_slice(&0xFFFFu16.to_be_bytes());
    vse.extend_from_slice(&wrap_box(cfg_fourcc, &cfg.record_4byte));
    let sample_entry = wrap_box(sample_fourcc, &vse);

    let mut stsd_body = Vec::with_capacity(8 + sample_entry.len());
    stsd_body.extend_from_slice(&[0, 0, 0, 0]);
    stsd_body.extend_from_slice(&1u32.to_be_bytes());
    stsd_body.extend_from_slice(&sample_entry);
    let mut stbl_body = Vec::new();
    stbl_body.extend_from_slice(&wrap_box(b"stsd", &stsd_body));
    stbl_body.extend_from_slice(&wrap_box(b"stts", &[0u8; 8]));
    stbl_body.extend_from_slice(&wrap_box(b"stsc", &[0u8; 8]));
    stbl_body.extend_from_slice(&wrap_box(b"stsz", &[0u8; 12]));
    stbl_body.extend_from_slice(&wrap_box(b"stco", &[0u8; 8]));

    let url_box = wrap_box(b"url ", &[0, 0, 0, 1]);
    let mut dref_body = vec![0, 0, 0, 0, 0, 0, 0, 1];
    dref_body.extend_from_slice(&url_box);
    let mut minf_body = Vec::new();
    minf_body.extend_from_slice(&wrap_box(b"vmhd", &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
    minf_body.extend_from_slice(&wrap_box(b"dinf", &wrap_box(b"dref", &dref_body)));
    minf_body.extend_from_slice(&wrap_box(b"stbl", &stbl_body));

    let mut mdhd = Vec::with_capacity(24);
    mdhd.extend_from_slice(&[0u8; 12]);
    mdhd.extend_from_slice(&VIDEO_TIMESCALE.to_be_bytes());
    mdhd.extend_from_slice(&0u32.to_be_bytes());
    mdhd.extend_from_slice(&21956u16.to_be_bytes()); // "und"
    mdhd.extend_from_slice(&0u16.to_be_bytes());

    let mut hdlr = Vec::with_capacity(37);
    hdlr.extend_from_slice(&[0u8; 8]);
    hdlr.extend_from_slice(b"vide");
    hdlr.extend_from_slice(&[0u8; 12]);
    hdlr.extend_from_slice(b"VideoHandler\0");

    let mut mdia_body = Vec::new();
    mdia_body.extend_from_slice(&wrap_box(b"mdhd", &mdhd));
    mdia_body.extend_from_slice(&wrap_box(b"hdlr", &hdlr));
    mdia_body.extend_from_slice(&wrap_box(b"minf", &minf_body));

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&wrap_box(b"tkhd", &tkhd));
    trak_body.extend_from_slice(&wrap_box(b"mdia", &mdia_body));

    let mut trex = Vec::with_capacity(24);
    trex.extend_from_slice(&[0, 0, 0, 0]);
    trex.extend_from_slice(&1u32.to_be_bytes());
    trex.extend_from_slice(&1u32.to_be_bytes());
    trex.extend_from_slice(&[0u8; 12]);

    let mut moov_body = Vec::new();
    moov_body.extend_from_slice(&wrap_box(b"mvhd", &mvhd));
    moov_body.extend_from_slice(&wrap_box(b"trak", &trak_body));
    moov_body.extend_from_slice(&wrap_box(b"mvex", &wrap_box(b"trex", &trex)));

    let moov = wrap_box(b"moov", &moov_body);
    let mut init = Vec::with_capacity(ftyp.len() + moov.len());
    init.extend_from_slice(&ftyp);
    init.extend_from_slice(&moov);
    init
}

struct GopPacket {
    pts_90k: i64,
    sync: bool,
    data_4byte: Vec<u8>,
}

fn build_fmp4_segment(
    seq: u32,
    gop: &[GopPacket],
    next_start_90k: Option<i64>,
    frame_90k: i64,
    min_dts_90k: &mut i64,
) -> Option<(Vec<u8>, f64, f64)> {
    if gop.is_empty() {
        return None;
    }
    let mut sorted_pts: Vec<i64> = gop.iter().map(|p| p.pts_90k.max(0)).collect();
    sorted_pts.sort_unstable();
    let mut dts = Vec::with_capacity(gop.len());
    let mut prev = *min_dts_90k - 1;
    for &p in &sorted_pts {
        let cur = p.max(prev + 1).max(0);
        dts.push(cur);
        prev = cur;
    }
    let last_dts = *dts.last().unwrap_or(&0);
    let end_dts = next_start_90k
        .filter(|&n| n > last_dts)
        .unwrap_or_else(|| last_dts + frame_90k.max(1));
    *min_dts_90k = end_dts;

    let base_decode_time = dts[0] as u64;
    let start_secs = (sorted_pts[0] as f64) / (VIDEO_TIMESCALE as f64);
    let end_secs = (end_dts as f64) / (VIDEO_TIMESCALE as f64);

    let moof_body_size = 16 + 64 + gop.len() * 16;
    let moof_size = 8 + moof_body_size;
    let payload_bytes: usize = gop.iter().map(|p| p.data_4byte.len()).sum();
    let mdat_size = 8 + payload_bytes;
    let data_offset = (moof_size + 8) as i32;

    let mut out = Vec::with_capacity(moof_size + mdat_size);
    out.extend_from_slice(&(moof_size as u32).to_be_bytes());
    out.extend_from_slice(b"moof");
    out.extend_from_slice(&16u32.to_be_bytes());
    out.extend_from_slice(b"mfhd");
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&seq.to_be_bytes());

    let traf_size = (64 + gop.len() * 16) as u32;
    out.extend_from_slice(&traf_size.to_be_bytes());
    out.extend_from_slice(b"traf");
    out.extend_from_slice(&16u32.to_be_bytes());
    out.extend_from_slice(b"tfhd");
    out.extend_from_slice(&[0, 0x02, 0x00, 0x00]);
    out.extend_from_slice(&1u32.to_be_bytes());

    out.extend_from_slice(&20u32.to_be_bytes());
    out.extend_from_slice(b"tfdt");
    out.extend_from_slice(&[1, 0, 0, 0]);
    out.extend_from_slice(&base_decode_time.to_be_bytes());

    let trun_size = (20 + gop.len() * 16) as u32;
    out.extend_from_slice(&trun_size.to_be_bytes());
    out.extend_from_slice(b"trun");
    out.extend_from_slice(&[1, 0x00, 0x0F, 0x01]);
    out.extend_from_slice(&(gop.len() as u32).to_be_bytes());
    out.extend_from_slice(&data_offset.to_be_bytes());

    for (i, pkt) in gop.iter().enumerate() {
        let next_d = dts.get(i + 1).copied().unwrap_or(end_dts);
        let dur = (next_d - dts[i]).clamp(1, i64::from(u32::MAX)) as u32;
        let cto = (pkt.pts_90k.max(0) - dts[i]).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let flags: u32 = if pkt.sync { 0x0200_0000 } else { 0x0101_0000 };
        out.extend_from_slice(&dur.to_be_bytes());
        out.extend_from_slice(&(pkt.data_4byte.len() as u32).to_be_bytes());
        out.extend_from_slice(&flags.to_be_bytes());
        out.extend_from_slice(&cto.to_be_bytes());
    }

    out.extend_from_slice(&(mdat_size as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for pkt in gop {
        out.extend_from_slice(&pkt.data_4byte);
    }
    Some((out, start_secs, end_secs))
}

fn strip_ass_overrides(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_brace = false;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '{' {
            in_brace = true;
            continue;
        }
        if ch == '}' {
            in_brace = false;
            continue;
        }
        if in_brace {
            continue;
        }
        if ch == '\\' {
            match chars.peek().copied() {
                Some('N' | 'n') => {
                    chars.next();
                    out.push('\n');
                    continue;
                }
                Some('h') => {
                    chars.next();
                    out.push(' ');
                    continue;
                }
                _ => {}
            }
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn collect_segments_text(items: &[Segment], out: &mut String, depth: u8) {
    if depth >= 32 {
        return;
    }
    for seg in items {
        match seg {
            Segment::Text(t) | Segment::Raw(t) => out.push_str(t),
            Segment::LineBreak => out.push('\n'),
            Segment::Timestamp { .. } => {}
            Segment::Bold(c) | Segment::Italic(c) | Segment::Underline(c) | Segment::Strike(c) => {
                collect_segments_text(c, out, depth + 1);
            }
            Segment::Color { children, .. }
            | Segment::Font { children, .. }
            | Segment::Karaoke { children, .. }
            | Segment::Voice { children, .. }
            | Segment::Class { children, .. } => collect_segments_text(c_slice(children), out, depth + 1),
        }
    }
}

#[inline]
fn c_slice(v: &[Segment]) -> &[Segment] {
    v
}

fn extract_visible_rgba(vf: &VideoFrame) -> Option<(i32, i32, u32, u32, u32, u32, Vec<u8>)> {
    let plane = vf.image_planes().first()?;
    let stride = plane.stride;
    if stride == 0 || stride % 4 != 0 {
        return None;
    }
    let width = stride / 4;
    let height = plane.data.len() / stride;
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return None;
    }
    let mut left = width;
    let mut right = 0usize;
    let mut top = height;
    let mut bottom = 0usize;
    for y in 0..height {
        let row = &plane.data[y * stride..y * stride + width * 4];
        let Some(first) = row.chunks_exact(4).position(|px| px[3] != 0) else {
            continue;
        };
        let last = row.chunks_exact(4).rposition(|px| px[3] != 0).unwrap_or(first);
        left = left.min(first);
        right = right.max(last + 1);
        top = top.min(y);
        bottom = y + 1;
    }
    if left >= right {
        return Some((0, 0, 0, 0, width as u32, height as u32, Vec::new()));
    }
    let cw = right - left;
    let ch = bottom - top;
    let mut rgba = Vec::with_capacity(cw * ch * 4);
    for y in top..bottom {
        let row = &plane.data[y * stride..y * stride + width * 4];
        rgba.extend_from_slice(&row[left * 4..right * 4]);
    }
    Some((
        left as i32,
        top as i32,
        cw as u32,
        ch as u32,
        width as u32,
        height as u32,
        rgba,
    ))
}

enum OutItem {
    MseInit(Vec<u8>),
    MseSegment { data: Vec<u8>, start: f64, end: f64 },
    VideoRgba { data: Vec<u8>, pts: f64, w: u32, h: u32 },
    AudioF32 { data: Vec<u8>, pts: f64, rate: u32, frames: u32 },
    SubText { text: Vec<u8>, start: f64, end: f64 },
    SubBitmap { rgba: Vec<u8>, start: f64, end: f64, x: i32, y: i32, w: u32, h: u32, cw: u32, ch: u32 },
}

struct PendingVideoFrame {
    pts: f64,
    w: u32,
    h: u32,
    fmt: PixelFormat,
    frame: VideoFrame,
}

struct WebSession {
    demuxer: Box<dyn Demuxer>,
    streams: Vec<StreamInfo>,
    mse_cfg: Option<MseVideoConfig>,
    peek_packets: VecDeque<Packet>,
    out_queue: VecDeque<OutItem>,
    video_idx: Option<u32>,
    audio_idx: Option<u32>,
    sub_idx: Option<u32>,
    use_mse: bool,
    video_dec: Option<Box<dyn Decoder>>,
    audio_dec: Option<Box<dyn Decoder>>,
    sub_dec: Option<Box<dyn Decoder>>,
    audio_mix: Option<(ChannelLayout, StereoMix)>,
    audio_next_pts: Option<f64>,
    video_next_pts: f64,
    sw_reorder: Vec<PendingVideoFrame>,
    mse_gop: Vec<GopPacket>,
    mse_seq: u32,
    mse_min_dts: i64,
    mse_started: bool,
    seek_target: Option<f64>,
    demux_eof: bool,
    flushed_eof: bool,
}

struct WasmState {
    session: Option<WebSession>,
    json_buf: Vec<u8>,
    out_buf: Vec<u8>,
    out_pts: f64,
    out_dur: f64,
    out_w: u32,
    out_h: u32,
    out_x: i32,
    out_y: i32,
    out_cw: u32,
    out_ch: u32,
    out_rate: u32,
    out_samples: u32,
}

impl Default for WasmState {
    fn default() -> Self {
        Self {
            session: None,
            json_buf: Vec::new(),
            out_buf: Vec::new(),
            out_pts: 0.0,
            out_dur: 0.0,
            out_w: 0,
            out_h: 0,
            out_x: 0,
            out_y: 0,
            out_cw: 0,
            out_ch: 0,
            out_rate: 0,
            out_samples: 0,
        }
    }
}

thread_local! {
    static STATE: RefCell<WasmState> = RefCell::new(WasmState::default());
}

fn set_json_error(st: &mut WasmState, msg: &str) -> i32 {
    st.json_buf = json!({ "error": msg }).to_string().into_bytes();
    -1
}

fn make_subtitle_cue(cue: &SubtitleCue, pkt_start: f64, pkt_dur: Option<f64>) -> Option<OutItem> {
    let mut buf = String::new();
    collect_segments_text(&cue.segments, &mut buf, 0);
    let cleaned = strip_ass_overrides(&buf);
    if cleaned.is_empty() {
        return None;
    }
    let (start, end) = if cue.end_us > cue.start_us {
        (
            (cue.start_us.max(0) as f64) / 1_000_000.0,
            (cue.end_us.max(0) as f64) / 1_000_000.0,
        )
    } else {
        (pkt_start, pkt_start + pkt_dur.unwrap_or(4.0))
    };
    Some(OutItem::SubText {
        text: cleaned.into_bytes(),
        start,
        end,
    })
}

impl WebSession {
    fn stream_info(&self, idx: u32) -> Option<&StreamInfo> {
        self.streams.iter().find(|s| s.index == idx)
    }

    fn rebuild_decoders(&mut self) {
        let ctx = &*REGISTRY;
        self.video_dec = None;
        self.audio_dec = None;
        self.sub_dec = None;
        self.audio_mix = None;
        self.audio_next_pts = None;
        self.video_next_pts = 0.0;
        self.sw_reorder.clear();
        self.mse_gop.clear();
        self.mse_started = false;

        if !self.use_mse
            && let Some(vi) = self.video_idx
            && let Some(s) = self.stream_info(vi).cloned()
        {
            self.video_dec = catch_unwind(AssertUnwindSafe(|| ctx.codecs.first_decoder(&s.params)))
                .ok()
                .and_then(Result::ok);
        }
        if let Some(ai) = self.audio_idx
            && let Some(s) = self.stream_info(ai).cloned()
        {
            self.audio_dec = catch_unwind(AssertUnwindSafe(|| ctx.codecs.first_decoder(&s.params)))
                .ok()
                .and_then(Result::ok);
        }
        if let Some(si) = self.sub_idx
            && let Some(s) = self.stream_info(si).cloned()
        {
            self.sub_dec = catch_unwind(AssertUnwindSafe(|| ctx.codecs.first_decoder(&s.params)))
                .ok()
                .and_then(Result::ok);
        }
    }

    fn flush_one_sw_frame(&mut self) -> bool {
        if self.sw_reorder.is_empty() {
            return false;
        }
        let min_idx = self
            .sw_reorder
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.pts.total_cmp(&b.pts))
            .map(|(i, _)| i)
            .unwrap_or(0);
        let item = self.sw_reorder.swap_remove(min_idx);
        if let Some(target) = self.seek_target
            && item.pts + 0.025 < target
        {
            return true;
        }
        let info = FrameInfo::new(item.fmt, item.w, item.h);
        let converted = catch_unwind(AssertUnwindSafe(|| {
            oxideav_pixfmt::convert(&item.frame, info, PixelFormat::Rgba, &ConvertOptions::default())
        }));
        if let Ok(Ok(rgba_frame)) = converted
            && let Some(plane) = rgba_frame.planes.first()
        {
            let row_bytes = (item.w as usize) * 4;
            let stride = plane.stride;
            let mut tight = Vec::with_capacity(row_bytes * item.h as usize);
            if stride == row_bytes && plane.data.len() >= row_bytes * item.h as usize {
                tight.extend_from_slice(&plane.data[..row_bytes * item.h as usize]);
            } else {
                for y in 0..item.h as usize {
                    let s = y * stride;
                    if s + row_bytes <= plane.data.len() {
                        tight.extend_from_slice(&plane.data[s..s + row_bytes]);
                    }
                }
            }
            if tight.len() == row_bytes * item.h as usize {
                self.out_queue.push_back(OutItem::VideoRgba {
                    data: tight,
                    pts: item.pts,
                    w: item.w,
                    h: item.h,
                });
            }
        }
        true
    }

    fn handle_video_packet(&mut self, pkt: Packet) {
        let Some(vi) = self.video_idx else { return };
        let Some(tb) = self.stream_info(vi).map(|s| s.time_base) else { return };
        let Some(default_w) = self.stream_info(vi).map(|s| s.params.width.unwrap_or(0)) else { return };
        let Some(default_h) = self.stream_info(vi).map(|s| s.params.height.unwrap_or(0)) else { return };
        let Some(default_pf) = self
            .stream_info(vi)
            .map(|s| s.params.pixel_format.unwrap_or(PixelFormat::Yuv420P))
        else {
            return;
        };
        let fps = self
            .stream_info(vi)
            .and_then(|s| s.params.frame_rate)
            .map(|r| if r.den > 0 { r.num as f64 / r.den as f64 } else { 0.0 })
            .filter(|&f| f > 1.0 && f < 240.0)
            .unwrap_or(24.0);

        if self.use_mse {
            let Some(cfg) = self.mse_cfg.clone() else { return };
            let raw_ticks = pkt.pts.or(pkt.dts).unwrap_or(0);
            let pts_secs = if tb.is_valid() { tb.seconds_of(raw_ticks).max(0.0) } else { 0.0 };
            let pts_90k = (pts_secs * f64::from(VIDEO_TIMESCALE)).round() as i64;
            let is_sync = pkt.flags.keyframe;

            if !self.mse_started {
                if !is_sync {
                    return;
                }
                self.mse_started = true;
                self.mse_min_dts = pts_90k;
            } else if is_sync && !self.mse_gop.is_empty() {
                let first_pts = self.mse_gop[0].pts_90k;
                let span_secs = ((pts_90k - first_pts) as f64) / f64::from(VIDEO_TIMESCALE);
                let target_span = if self.mse_seq == 0 { 0.4 } else { 1.5 };
                if span_secs >= target_span {
                    self.mse_seq = self.mse_seq.wrapping_add(1);
                    let gop = std::mem::take(&mut self.mse_gop);
                    if let Some((seg, start, end)) = build_fmp4_segment(
                        self.mse_seq,
                        &gop,
                        Some(pts_90k),
                        cfg.frame_ticks_90k,
                        &mut self.mse_min_dts,
                    ) {
                        self.out_queue.push_back(OutItem::MseSegment { data: seg, start, end });
                    }
                }
            }
            let data_4byte = to_4byte_nals(&pkt.data, cfg.framing);
            if !data_4byte.is_empty() {
                self.mse_gop.push(GopPacket {
                    pts_90k,
                    sync: is_sync,
                    data_4byte,
                });
            }
            return;
        }

        if let Some(dec) = self.video_dec.as_mut() {
            let pkt_pts = pkt.pts.or(pkt.dts);
            if catch_unwind(AssertUnwindSafe(|| dec.send_packet(&pkt))).is_err() {
                return;
            }
            loop {
                let recv = catch_unwind(AssertUnwindSafe(|| dec.receive_frame()));
                let vf = match recv {
                    Ok(Ok(Frame::Video(vf))) => vf,
                    Ok(Ok(_)) => continue,
                    _ => break,
                };
                let (w, h) = dec.output_video_dimensions().unwrap_or((default_w, default_h));
                let fmt = dec.output_pixel_format().unwrap_or(default_pf);
                if w == 0 || h == 0 || w > 8192 || h > 8192 {
                    continue;
                }
                let pts_secs = match vf.pts.or(pkt_pts) {
                    Some(t) if tb.is_valid() => {
                        let s = tb.seconds_of(t).max(0.0);
                        self.video_next_pts = s + 1.0 / fps;
                        s
                    }
                    _ => {
                        let s = self.video_next_pts;
                        self.video_next_pts += 1.0 / fps;
                        s
                    }
                };
                self.sw_reorder.push(PendingVideoFrame {
                    pts: pts_secs,
                    w,
                    h,
                    fmt,
                    frame: vf,
                });
            }
        }
        while self.sw_reorder.len() > 6 {
            self.flush_one_sw_frame();
        }
    }

    fn handle_audio_packet(&mut self, pkt: Packet) {
        let Some(ai) = self.audio_idx else { return };
        let Some(stream) = self.stream_info(ai).cloned() else { return };
        let Some(dec) = self.audio_dec.as_mut() else { return };
        let mut pkt_pts = pkt.pts.or(pkt.dts);
        if catch_unwind(AssertUnwindSafe(|| dec.send_packet(&pkt))).is_err() {
            return;
        }
        loop {
            let recv = catch_unwind(AssertUnwindSafe(|| dec.receive_frame()));
            let af = match recv {
                Ok(Ok(Frame::Audio(af))) => af,
                Ok(Ok(_)) => continue,
                _ => break,
            };
            if af.samples == 0 {
                continue;
            }
            let af_layout = audio_trim::frame_layout(dec.output_audio_format(), &stream.params, &af);
            let (format, rate, channels) = (
                af_layout.sample_format,
                af_layout.sample_rate.max(8000),
                (af_layout.channels as usize).max(1),
            );
            let raw_pcm = convert_audio_to_f32(&af, format, channels);
            let frames = raw_pcm.len() / channels;
            if frames == 0 {
                continue;
            }
            let pts_secs = match (af.pts.or(pkt_pts.take()), self.audio_next_pts) {
                (Some(t), _) if stream.time_base.is_valid() => stream.time_base.seconds_of(t).max(0.0),
                (_, Some(next)) => next,
                _ => 0.0,
            };
            self.audio_next_pts = Some(pts_secs + (frames as f64) / f64::from(rate));
            if let Some(target) = self.seek_target
                && pts_secs + (frames as f64) / f64::from(rate) < target - 0.02
            {
                continue;
            }
            let chan_layout = stream
                .params
                .resolved_layout()
                .filter(|l| usize::from(l.channel_count()) == channels)
                .unwrap_or_else(|| ChannelLayout::from_count(channels as u16));
            let need_new_mix = self
                .audio_mix
                .as_ref()
                .is_none_or(|(prev, _)| *prev != chan_layout);
            if need_new_mix {
                self.audio_mix = Some((chan_layout, StereoMix::new(chan_layout)));
            }
            let stereo = self.audio_mix.as_ref().unwrap().1.mix(&raw_pcm);
            let stereo_frames = (stereo.len() / 2) as u32;
            let mut bytes = Vec::with_capacity(stereo.len() * 4);
            for sample in stereo {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            self.out_queue.push_back(OutItem::AudioF32 {
                data: bytes,
                pts: pts_secs,
                rate,
                frames: stereo_frames,
            });
        }
    }

    fn handle_sub_packet(&mut self, pkt: Packet) {
        let Some(si) = self.sub_idx else { return };
        let Some(tb) = self.stream_info(si).map(|s| s.time_base) else { return };
        let Some(codec_id) = self.stream_info(si).map(|s| s.params.codec_id.as_str().to_string()) else {
            return;
        };
        let pkt_start = pkt
            .pts
            .or(pkt.dts)
            .map(|t| if tb.is_valid() { tb.seconds_of(t).max(0.0) } else { 0.0 })
            .unwrap_or(0.0);
        let pkt_dur = pkt
            .duration
            .filter(|&d| d > 0)
            .map(|d| if tb.is_valid() { tb.seconds_of(d).max(0.0) } else { 0.0 });

        // ASS/SSA Dialogue packets in MKV hold clean event text after the 8th comma (`ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`).
        if matches!(codec_id.as_str(), "ass" | "ssa") && let Ok(raw) = std::str::from_utf8(&pkt.data) {
            let text_part = if raw.starts_with("Dialogue:") {
                raw.splitn(10, ',').nth(9).unwrap_or(raw)
            } else {
                raw.splitn(9, ',').nth(8).unwrap_or(raw)
            };
            let cleaned = strip_ass_overrides(text_part);
            if !cleaned.is_empty() {
                let end = pkt_start + pkt_dur.unwrap_or(4.0);
                self.out_queue.push_back(OutItem::SubText {
                    text: cleaned.into_bytes(),
                    start: pkt_start,
                    end,
                });
                return;
            }
        }

        let mut sub_items = Vec::new();
        if let Some(dec) = self.sub_dec.as_mut() {
            if catch_unwind(AssertUnwindSafe(|| dec.send_packet(&pkt))).is_err() {
                return;
            }
            loop {
                let recv = catch_unwind(AssertUnwindSafe(|| dec.receive_frame()));
                match recv {
                    Ok(Ok(Frame::Subtitle(cue))) => {
                        if let Some(item) = make_subtitle_cue(&cue, pkt_start, pkt_dur) {
                            sub_items.push(item);
                        }
                    }
                    Ok(Ok(Frame::Video(vf))) => {
                        let dur = vf
                            .display_duration()
                            .map(|d| d.as_secs_f64())
                            .or(pkt_dur)
                            .unwrap_or(5.0);
                        if let Some((x, y, w, h, cw, ch, rgba)) = extract_visible_rgba(&vf) {
                            sub_items.push(OutItem::SubBitmap {
                                rgba,
                                start: pkt_start,
                                end: pkt_start + dur,
                                x,
                                y,
                                w,
                                h,
                                cw,
                                ch,
                            });
                        }
                    }
                    Ok(Ok(_)) => continue,
                    _ => break,
                }
            }
        }
        self.out_queue.extend(sub_items);
    }

    fn flush_eof(&mut self) {
        if self.flushed_eof {
            return;
        }
        self.flushed_eof = true;
        if self.use_mse {
            if !self.mse_gop.is_empty() && let Some(cfg) = self.mse_cfg.clone() {
                self.mse_seq = self.mse_seq.wrapping_add(1);
                let gop = std::mem::take(&mut self.mse_gop);
                if let Some((seg, start, end)) =
                    build_fmp4_segment(self.mse_seq, &gop, None, cfg.frame_ticks_90k, &mut self.mse_min_dts)
                {
                    self.out_queue.push_back(OutItem::MseSegment { data: seg, start, end });
                }
            }
        } else {
            let vinfo = self.video_idx.and_then(|vi| self.stream_info(vi).cloned());
            if let (Some(dec), Some(s)) = (self.video_dec.as_mut(), vinfo) {
                let _ = catch_unwind(AssertUnwindSafe(|| dec.flush()));
                loop {
                    let Ok(Ok(Frame::Video(vf))) = catch_unwind(AssertUnwindSafe(|| dec.receive_frame()))
                    else {
                        break;
                    };
                    let (w, h) = dec
                        .output_video_dimensions()
                        .unwrap_or((s.params.width.unwrap_or(0), s.params.height.unwrap_or(0)));
                    let fmt = dec
                        .output_pixel_format()
                        .unwrap_or(s.params.pixel_format.unwrap_or(PixelFormat::Yuv420P));
                    let pts = vf
                        .pts
                        .filter(|_| s.time_base.is_valid())
                        .map(|t| s.time_base.seconds_of(t).max(0.0))
                        .unwrap_or(self.video_next_pts);
                    self.video_next_pts = pts + 0.04;
                    self.sw_reorder.push(PendingVideoFrame { pts, w, h, fmt, frame: vf });
                }
            }
            while self.flush_one_sw_frame() {}
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_json_ptr() -> *const u8 {
    STATE.with(|c| c.borrow().json_buf.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_json_len() -> usize {
    STATE.with(|c| c.borrow().json_buf.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_ptr() -> *const u8 {
    STATE.with(|c| c.borrow().out_buf.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_len() -> usize {
    STATE.with(|c| c.borrow().out_buf.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_pts() -> f64 {
    STATE.with(|c| c.borrow().out_pts)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_dur() -> f64 {
    STATE.with(|c| c.borrow().out_dur)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_w() -> u32 {
    STATE.with(|c| c.borrow().out_w)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_h() -> u32 {
    STATE.with(|c| c.borrow().out_h)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_x() -> i32 {
    STATE.with(|c| c.borrow().out_x)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_y() -> i32 {
    STATE.with(|c| c.borrow().out_y)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_cw() -> u32 {
    STATE.with(|c| c.borrow().out_cw)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_ch() -> u32 {
    STATE.with(|c| c.borrow().out_ch)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_rate() -> u32 {
    STATE.with(|c| c.borrow().out_rate)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_samples() -> u32 {
    STATE.with(|c| c.borrow().out_samples)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_open(ext_ptr: *const u8, ext_len: usize) -> i32 {
    let ext_hint = if !ext_ptr.is_null() && ext_len > 0 {
        let slice = unsafe { std::slice::from_raw_parts(ext_ptr, ext_len) };
        std::str::from_utf8(slice).ok().map(str::to_ascii_lowercase)
    } else {
        None
    };

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        st.session = None;
        let ctx = &*REGISTRY;
        let mut src = HttpRangeSource::new();
        if src.len == 0 {
            return set_json_error(&mut st, "Stream has zero bytes");
        }
        let mut probe_buf = vec![0u8; (256 * 1024).min(src.len as usize)];
        let mut read_n = 0usize;
        while read_n < probe_buf.len() {
            match src.read(&mut probe_buf[read_n..]) {
                Ok(0) => break,
                Ok(n) => read_n += n,
                Err(e) => return set_json_error(&mut st, &format!("Probe read error: {e}")),
            }
        }
        probe_buf.truncate(read_n);
        if let Err(e) = src.seek(SeekFrom::Start(0)) {
            return set_json_error(&mut st, &format!("Probe rewind error: {e}"));
        }

        let probe_data = ProbeData {
            buf: &probe_buf,
            ext: ext_hint.as_deref(),
        };
        let candidates = ctx.containers.probe_candidates(&probe_data);
        let by_ext = ext_hint
            .as_deref()
            .and_then(|e| ctx.containers.container_for_extension(e));
        let Some(container) = (match (candidates.first(), by_ext) {
            (Some(c), _) if c.score >= PROBE_SCORE_EXTENSION => Some(c.name.to_string()),
            (_, Some(name)) => Some(name.to_string()),
            (Some(c), _) => Some(c.name.to_string()),
            _ => None,
        }) else {
            return set_json_error(&mut st, "Unsupported media container");
        };

        let mut demuxer = match catch_unwind(AssertUnwindSafe(|| {
            ctx.containers.open_demuxer(&container, Box::new(src), &ctx.codecs)
        })) {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => return set_json_error(&mut st, &format!("Demuxer error ({container}): {e}")),
            Err(_) => return set_json_error(&mut st, &format!("Demuxer panicked opening {container}")),
        };

        let streams: Vec<StreamInfo> = demuxer.streams().iter().take(64).cloned().collect();
        let mut first_video: Option<u32> = None;
        let mut first_audio: Option<u32> = None;
        let mut tracks_json = Vec::new();
        for s in &streams {
            let kind = match s.params.media_type {
                MediaType::Video => {
                    if first_video.is_none() {
                        first_video = Some(s.index);
                    }
                    "video"
                }
                MediaType::Audio => {
                    if first_audio.is_none() {
                        first_audio = Some(s.index);
                    }
                    "audio"
                }
                MediaType::Subtitle => "subtitle",
                _ => continue,
            };
            tracks_json.push(json!({
                "stream": s.index,
                "kind": kind,
                "codec": s.params.codec_id.as_str(),
                "language": s.params.language,
                "width": s.params.width,
                "height": s.params.height,
                "channels": s.params.channels,
                "sampleRate": s.params.sample_rate,
            }));
        }

        let duration_secs = demuxer
            .duration_micros()
            .map(|us| (us.max(0) as f64) / 1_000_000.0)
            .or_else(|| {
                streams
                    .iter()
                    .filter_map(|s| {
                        s.duration.and_then(|d| {
                            if s.time_base.is_valid() {
                                Some(s.time_base.seconds_of(d).max(0.0))
                            } else {
                                None
                            }
                        })
                    })
                    .fold(None::<f64>, |acc, x| Some(acc.map_or(x, |a| a.max(x))))
            })
            .unwrap_or(0.0);

        // Peek ahead up to 128 packets only if needed to grab Annex B SPS/PPS from the first keyframe, keeping every packet.
        let mut peek_packets = VecDeque::new();
        let mut mse_cfg = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .and_then(|vs| probe_mse_video(vs, None));
        if mse_cfg.is_none()
            && let Some(vi) = first_video
            && let Some(vs) = streams.iter().find(|s| s.index == vi).cloned()
            && matches!(vs.params.codec_id.as_str(), "h264" | "h265" | "hevc")
        {
            for _ in 0..128 {
                let Ok(Ok(pkt)) = catch_unwind(AssertUnwindSafe(|| demuxer.next_packet())) else {
                    break;
                };
                let is_vkf = pkt.stream_index == vi && pkt.flags.keyframe;
                peek_packets.push_back(pkt);
                if is_vkf {
                    mse_cfg = probe_mse_video(&vs, peek_packets.back().map(|p| p.data.as_slice()));
                    break;
                }
            }
        }

        let (width, height) = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .map(|s| (s.params.width.unwrap_or(0), s.params.height.unwrap_or(0)))
            .unwrap_or((0, 0));

        let manifest = json!({
            "container": container,
            "duration": duration_secs,
            "width": mse_cfg.as_ref().map_or(width, |c| c.width),
            "height": mse_cfg.as_ref().map_or(height, |c| c.height),
            "mseCodec": mse_cfg.as_ref().map(|c| c.codec_string.as_str()),
            "tracks": tracks_json,
            "defaultVideo": first_video,
            "defaultAudio": first_audio,
            "defaultSubtitle": serde_json::Value::Null,
        });
        st.json_buf = manifest.to_string().into_bytes();
        st.session = Some(WebSession {
            demuxer,
            streams,
            mse_cfg,
            peek_packets,
            out_queue: VecDeque::new(),
            video_idx: first_video,
            audio_idx: first_audio,
            sub_idx: None,
            use_mse: false,
            video_dec: None,
            audio_dec: None,
            sub_dec: None,
            audio_mix: None,
            audio_next_pts: None,
            video_next_pts: 0.0,
            sw_reorder: Vec::new(),
            mse_gop: Vec::new(),
            mse_seq: 0,
            mse_min_dts: 0,
            mse_started: false,
            seek_target: None,
            demux_eof: false,
            flushed_eof: false,
        });
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_configure(video_stream: i32, audio_stream: i32, sub_stream: i32, use_mse: i32) -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return set_json_error(&mut st, "No open session");
        };
        sess.video_idx = (video_stream >= 0).then_some(video_stream as u32);
        sess.audio_idx = (audio_stream >= 0).then_some(audio_stream as u32);
        sess.sub_idx = (sub_stream >= 0).then_some(sub_stream as u32);
        sess.use_mse = use_mse != 0 && sess.mse_cfg.is_some();
        sess.out_queue.clear();

        let mut active = Vec::new();
        if let Some(v) = sess.video_idx {
            active.push(v);
        }
        if let Some(a) = sess.audio_idx {
            active.push(a);
        }
        if let Some(s) = sess.sub_idx {
            active.push(s);
        }
        sess.demuxer.set_active_streams(&active);
        sess.rebuild_decoders();

        if sess.use_mse
            && let Some(cfg) = sess.mse_cfg.as_ref()
        {
            sess.out_queue.push_back(OutItem::MseInit(build_fmp4_init(cfg)));
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_seek(target_secs: f64) -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return set_json_error(&mut st, "No open session");
        };
        let clamped = target_secs.max(0.0);
        let seek_stream = sess.video_idx.or(sess.audio_idx).unwrap_or(0);
        let tb = sess
            .stream_info(seek_stream)
            .map(|s| s.time_base)
            .filter(|tb| tb.is_valid())
            .unwrap_or_else(|| TimeBase::new(1, 1000));
        let ticks = tb.ticks_of(clamped);

        sess.peek_packets.clear();
        sess.out_queue.clear();
        sess.demux_eof = false;
        sess.flushed_eof = false;
        sess.seek_target = Some(clamped);

        let res = catch_unwind(AssertUnwindSafe(|| sess.demuxer.seek_to(seek_stream, ticks)));
        if let Err(_) | Ok(Err(_)) = res {
            // Best-effort rewind fallback if container lacks index
            let _ = catch_unwind(AssertUnwindSafe(|| sess.demuxer.seek_to(seek_stream, 0)));
        }
        sess.rebuild_decoders();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_step() -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let code = {
            let Some(sess) = st.session.as_mut() else {
                return set_json_error(&mut st, "No open session");
            };
            let mut safety = 0usize;
            while sess.out_queue.is_empty() && safety < 4096 {
                safety += 1;
                if sess.demux_eof {
                    sess.flush_eof();
                    break;
                }
                let next_pkt = if let Some(p) = sess.peek_packets.pop_front() {
                    Ok(p)
                } else {
                    match catch_unwind(AssertUnwindSafe(|| sess.demuxer.next_packet())) {
                        Ok(r) => r,
                        Err(_) => Err(AvError::Other("demuxer panicked".into())),
                    }
                };
                match next_pkt {
                    Ok(pkt) => {
                        if Some(pkt.stream_index) == sess.video_idx {
                            sess.handle_video_packet(pkt);
                        } else if Some(pkt.stream_index) == sess.audio_idx {
                            sess.handle_audio_packet(pkt);
                        } else if Some(pkt.stream_index) == sess.sub_idx {
                            sess.handle_sub_packet(pkt);
                        }
                    }
                    Err(AvError::Eof) => {
                        sess.demux_eof = true;
                        sess.flush_eof();
                        break;
                    }
                    Err(e) => {
                        return set_json_error(&mut st, &format!("Demux error: {e}"));
                    }
                }
            }
            match sess.out_queue.pop_front() {
                None => return 0,
                Some(OutItem::MseInit(data)) => {
                    st.out_buf = data;
                    st.out_pts = 0.0;
                    st.out_dur = 0.0;
                    1
                }
                Some(OutItem::MseSegment { data, start, end }) => {
                    st.out_buf = data;
                    st.out_pts = start;
                    st.out_dur = end;
                    2
                }
                Some(OutItem::VideoRgba { data, pts, w, h }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_w = w;
                    st.out_h = h;
                    3
                }
                Some(OutItem::AudioF32 { data, pts, rate, frames }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_rate = rate;
                    st.out_samples = frames;
                    4
                }
                Some(OutItem::SubText { text, start, end }) => {
                    st.out_buf = text;
                    st.out_pts = start;
                    st.out_dur = end;
                    5
                }
                Some(OutItem::SubBitmap { rgba, start, end, x, y, w, h, cw, ch }) => {
                    st.out_buf = rgba;
                    st.out_pts = start;
                    st.out_dur = end;
                    st.out_x = x;
                    st.out_y = y;
                    st.out_w = w;
                    st.out_h = h;
                    st.out_cw = cw;
                    st.out_ch = ch;
                    6
                }
            }
        };
        code
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_close() {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        st.session = None;
        st.out_buf = Vec::new();
    });
}

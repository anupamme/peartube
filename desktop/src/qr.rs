//! Zero-dependency ISO/IEC 18004 QR Code encoder (Versions 1–14, Byte mode, ECC Level M)
//! and crisp Retina quad renderer for GPUI.

use gpui_kit::*;

const V_M: [(usize, usize, usize, usize, usize, usize); 15] = [
    (0, 0, 0, 0, 0, 0),
    (26, 10, 1, 16, 0, 0),
    (44, 16, 1, 28, 0, 0),
    (70, 26, 1, 44, 0, 0),
    (100, 18, 2, 32, 0, 0),
    (134, 24, 2, 43, 0, 0),
    (172, 16, 4, 27, 0, 0),
    (196, 18, 4, 31, 0, 0),
    (242, 22, 2, 38, 2, 39),
    (292, 22, 3, 36, 2, 37),
    (346, 26, 4, 43, 1, 44),
    (404, 30, 1, 50, 4, 51),
    (466, 22, 6, 36, 2, 37),
    (532, 22, 8, 37, 1, 38),
    (581, 24, 4, 40, 5, 41),
];

fn align_coords(ver: usize) -> &'static [isize] {
    match ver {
        0 | 1 => &[],
        2 => &[6, 18],
        3 => &[6, 22],
        4 => &[6, 26],
        5 => &[6, 30],
        6 => &[6, 34],
        7 => &[6, 22, 38],
        8 => &[6, 24, 42],
        9 => &[6, 26, 46],
        10 => &[6, 28, 50],
        11 => &[6, 30, 54],
        12 => &[6, 32, 58],
        13 => &[6, 34, 62],
        _ => &[6, 26, 46, 66],
    }
}

fn gf_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut x: u16 = 1;
    for i in 0..255 {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if (x & 0x100) != 0 {
            x ^= 0x11d;
        }
    }
    for i in 255..512 {
        exp[i] = exp[i - 255];
    }
    (exp, log)
}

fn rs_remainder(data: &[u8], degree: usize, exp: &[u8; 512], log: &[u8; 256]) -> Vec<u8> {
    let gf_mul = |a: u8, b: u8| -> u8 {
        if a == 0 || b == 0 { 0 } else { exp[log[a as usize] as usize + log[b as usize] as usize] }
    };
    let mut poly = vec![1u8];
    for i in 0..degree {
        let mut next = vec![0u8; poly.len() + 1];
        let root = exp[i];
        for (j, &p) in poly.iter().enumerate() {
            next[j] ^= p;
            next[j + 1] ^= gf_mul(p, root);
        }
        poly = next;
    }
    let mut rem = vec![0u8; degree];
    for &byte in data {
        let factor = byte ^ rem[0];
        rem.copy_within(1..degree, 0);
        rem[degree - 1] = 0;
        for j in 0..degree {
            rem[j] ^= gf_mul(poly[j + 1], factor);
        }
    }
    rem
}

fn bch_format(mask: u32) -> u32 {
    let data = mask & 0b111; // ECC Level M = 00
    let mut rem = data << 10;
    for i in (10..=14).rev() {
        if ((rem >> i) & 1) != 0 {
            rem ^= 0x537 << (i - 10);
        }
    }
    ((data << 10) | rem) ^ 0x5412
}

fn bch_version(ver: u32) -> u32 {
    let mut rem = ver << 12;
    for i in (12..=17).rev() {
        if ((rem >> i) & 1) != 0 {
            rem ^= 0x1f25 << (i - 12);
        }
    }
    (ver << 12) | rem
}

fn penalty(mat: &[u8], size: usize) -> usize {
    let mut score = 0usize;
    for y in 0..size {
        let mut rh = 1usize;
        let mut rv = 1usize;
        for x in 1..size {
            if mat[y * size + x] == mat[y * size + x - 1] {
                rh += 1;
                if rh == 5 { score += 3; } else if rh > 5 { score += 1; }
            } else {
                rh = 1;
            }
            if mat[x * size + y] == mat[(x - 1) * size + y] {
                rv += 1;
                if rv == 5 { score += 3; } else if rv > 5 { score += 1; }
            } else {
                rv = 1;
            }
        }
    }
    for y in 0..(size - 1) {
        for x in 0..(size - 1) {
            let c = mat[y * size + x];
            if c == mat[y * size + x + 1] && c == mat[(y + 1) * size + x] && c == mat[(y + 1) * size + x + 1] {
                score += 3;
            }
        }
    }
    let dark = mat.iter().filter(|&&b| b != 0).count();
    let pct = (dark * 100) / mat.len();
    score + (pct.abs_diff(50) / 5) * 10
}

pub fn encode_qr(text: &str) -> Option<(usize, Vec<u8>)> {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let mut ver = 1usize;
    while ver < V_M.len() {
        let (_, _, g1b, g1d, g2b, g2d) = V_M[ver];
        let cap = g1b * g1d + g2b * g2d;
        let hdr = 4 + if ver <= 9 { 8 } else { 16 };
        if hdr + bytes.len() * 8 <= cap * 8 {
            break;
        }
        ver += 1;
    }
    if ver >= V_M.len() {
        return None;
    }

    let (_, ec_len, g1b, g1d, g2b, g2d) = V_M[ver];
    let total_data = g1b * g1d + g2b * g2d;
    let mut bits = Vec::with_capacity(total_data * 8);
    fn push_bits(bits: &mut Vec<u8>, val: usize, len: usize) {
        for i in (0..len).rev() {
            bits.push(((val >> i) & 1) as u8);
        }
    }
    push_bits(&mut bits, 0b0100, 4);
    push_bits(&mut bits, bytes.len(), if ver <= 9 { 8 } else { 16 });
    for &b in bytes {
        push_bits(&mut bits, b as usize, 8);
    }
    let term = 4.min(total_data * 8 - bits.len());
    push_bits(&mut bits, 0, term);
    while bits.len() % 8 != 0 {
        bits.push(0);
    }

    let mut data_cw = vec![0u8; total_data];
    for i in 0..(bits.len() / 8) {
        let mut b = 0u8;
        for j in 0..8 {
            b = (b << 1) | bits[i * 8 + j];
        }
        data_cw[i] = b;
    }
    for (idx, slot) in data_cw.iter_mut().enumerate().skip(bits.len() / 8) {
        *slot = if (idx - bits.len() / 8) % 2 == 0 { 0xec } else { 0x11 };
    }

    let (exp, log) = gf_tables();
    let mut blocks = Vec::new();
    let mut ecs = Vec::new();
    let mut off = 0usize;
    for _ in 0..g1b {
        let blk = &data_cw[off..off + g1d];
        off += g1d;
        blocks.push(blk);
        ecs.push(rs_remainder(blk, ec_len, &exp, &log));
    }
    for _ in 0..g2b {
        let blk = &data_cw[off..off + g2d];
        off += g2d;
        blocks.push(blk);
        ecs.push(rs_remainder(blk, ec_len, &exp, &log));
    }

    let mut codewords = Vec::with_capacity(total_data + ec_len * (g1b + g2b));
    for i in 0..g1d.max(g2d) {
        for blk in &blocks {
            if i < blk.len() {
                codewords.push(blk[i]);
            }
        }
    }
    for i in 0..ec_len {
        for ec in &ecs {
            codewords.push(ec[i]);
        }
    }

    let size = ver * 4 + 17;
    let mut base = vec![0u8; size * size];
    let mut is_fn = vec![false; size * size];
    let mut set_fn = |x: isize, y: isize, dark: bool| {
        if x >= 0 && y >= 0 && (x as usize) < size && (y as usize) < size {
            let idx = (y as usize) * size + (x as usize);
            base[idx] = u8::from(dark);
            is_fn[idx] = true;
        }
    };

    for (ox, oy) in [(0isize, 0isize), (size as isize - 7, 0), (0, size as isize - 7)] {
        for dy in -1..=7 {
            for dx in -1..=7 {
                let outer = (0..=6).contains(&dx) && (0..=6).contains(&dy);
                let ring = dx == 0 || dx == 6 || dy == 0 || dy == 6;
                let core = (2..=4).contains(&dx) && (2..=4).contains(&dy);
                set_fn(ox + dx, oy + dy, outer && (ring || core));
            }
        }
    }
    for i in 8..(size as isize - 8) {
        set_fn(i, 6, i % 2 == 0);
        set_fn(6, i, i % 2 == 0);
    }
    let pos = align_coords(ver);
    for (i, &cx) in pos.iter().enumerate() {
        for (j, &cy) in pos.iter().enumerate() {
            if (i == 0 && j == 0) || (i == 0 && j + 1 == pos.len()) || (i + 1 == pos.len() && j == 0) {
                continue;
            }
            for dy in -2..=2 {
                for dx in -2..=2 {
                    set_fn(cx + dx, cy + dy, dx.abs().max(dy.abs()) != 1);
                }
            }
        }
    }
    for i in 0..=8isize {
        if i != 6 {
            set_fn(8, i, false);
            set_fn(i, 8, false);
        }
    }
    for i in 0..8isize {
        set_fn(size as isize - 1 - i, 8, false);
        set_fn(8, size as isize - 1 - i, false);
    }
    set_fn(8, size as isize - 8, true);

    if ver >= 7 {
        let vb = bch_version(ver as u32);
        for i in 0..18usize {
            let bit = ((vb >> i) & 1) == 1;
            let a = (size - 11 + (i % 3)) as isize;
            let b = (i / 3) as isize;
            set_fn(a, b, bit);
            set_fn(b, a, bit);
        }
    }

    let mut bit_idx = 0usize;
    let total_bits = codewords.len() * 8;
    let mut upward = true;
    let mut right = size as isize - 1;
    while right >= 1 {
        if right == 6 {
            right = 5;
        }
        for vert in 0..size {
            let y = if upward { size - 1 - vert } else { vert };
            for j in 0..2isize {
                let x = (right - j) as usize;
                if is_fn[y * size + x] {
                    continue;
                }
                let mut dark = 0u8;
                if bit_idx < total_bits {
                    dark = (codewords[bit_idx >> 3] >> (7 - (bit_idx & 7))) & 1;
                    bit_idx += 1;
                }
                base[y * size + x] = dark;
            }
        }
        upward = !upward;
        right -= 2;
    }

    let mut best = base.clone();
    let mut best_score = usize::MAX;
    for m in 0..8usize {
        let mut cand = base.clone();
        for y in 0..size {
            for x in 0..size {
                if is_fn[y * size + x] {
                    continue;
                }
                let flip = match m {
                    0 => (x + y) % 2 == 0,
                    1 => y % 2 == 0,
                    2 => x % 3 == 0,
                    3 => (x + y) % 3 == 0,
                    4 => ((y / 2) + (x / 3)) % 2 == 0,
                    5 => ((x * y) % 2) + ((x * y) % 3) == 0,
                    6 => (((x * y) % 2) + ((x * y) % 3)) % 2 == 0,
                    _ => (((x + y) % 2) + ((x * y) % 3)) % 2 == 0,
                };
                if flip {
                    cand[y * size + x] ^= 1;
                }
            }
        }
        let fbits = bch_format(m as u32);
        for i in 0..=5usize { cand[i * size + 8] = ((fbits >> i) & 1) as u8; }
        cand[7 * size + 8] = ((fbits >> 6) & 1) as u8;
        cand[8 * size + 8] = ((fbits >> 7) & 1) as u8;
        cand[8 * size + 7] = ((fbits >> 8) & 1) as u8;
        for i in 9..15usize { cand[8 * size + (14 - i)] = ((fbits >> i) & 1) as u8; }
        for i in 0..8usize { cand[8 * size + (size - 1 - i)] = ((fbits >> i) & 1) as u8; }
        for i in 8..15usize { cand[(size - 15 + i) * size + 8] = ((fbits >> i) & 1) as u8; }
        cand[(size - 8) * size + 8] = 1;

        let sc = penalty(&cand, size);
        if sc < best_score {
            best_score = sc;
            best = cand;
        }
    }
    Some((size, best))
}

/// Crisp high-contrast QR card with a 4-module white quiet zone painted as integer quads.
pub fn qr_card(data: &str, card_px: f32) -> Div {
    let encoded = encode_qr(data);
    div()
        .size(px(card_px))
        .flex_shrink_0()
        .rounded(px(20.))
        .bg(white())
        .p(px(12.))
        .child(
            canvas(
                move |_, _, _| encoded.clone(),
                move |bounds, state, window, _| {
                    let Some((size, modules)) = state else { return };
                    let quiet = 2usize; // outer p(12) + 2 modules = generous quiet zone
                    let grid = (size + quiet * 2) as f32;
                    let avail = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
                    let cell = (avail / grid).floor().max(1.0);
                    let total = cell * grid;
                    let ox = f32::from(bounds.origin.x) + ((f32::from(bounds.size.width) - total) * 0.5).floor();
                    let oy = f32::from(bounds.origin.y) + ((f32::from(bounds.size.height) - total) * 0.5).floor();

                    for y in 0..size {
                        let mut x = 0usize;
                        while x < size {
                            if modules[y * size + x] == 0 {
                                x += 1;
                                continue;
                            }
                            let mut run = 1usize;
                            while x + run < size && modules[y * size + x + run] != 0 {
                                run += 1;
                            }
                            let quad = Bounds {
                                origin: point(px(ox + ((x + quiet) as f32) * cell), px(oy + ((y + quiet) as f32) * cell)),
                                size: gpui_kit::size(px((run as f32) * cell), px(cell)),
                            };
                            window.paint_quad(fill(quad, black()));
                            x += run;
                        }
                    }
                },
            )
            .size_full(),
        )
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Мелочи без состояния: время, случайные значения, хеши, проверка входных строк.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hmac256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC принимает ключ любой длины");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Сравнение без утечки по времени.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// Время в виде 2026-11-10T17:05:09.123Z.
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // гражданская дата из числа дней (алгоритм Говарда Хиннанта)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60, millis)
}

pub fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Имя ящика: 3–32 знака, латиница, цифры, точка, дефис, подчёркивание; начинается и
/// заканчивается буквой или цифрой, разделители не идут подряд. То же правило у браузера.
pub fn valid_local(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 3 || b.len() > 32 {
        return false;
    }
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let sep = |c: u8| c == b'.' || c == b'-' || c == b'_';
    if !alnum(b[0]) || !alnum(b[b.len() - 1]) {
        return false;
    }
    let mut prev_sep = false;
    for &c in b {
        if sep(c) {
            if prev_sep {
                return false;
            }
            prev_sep = true;
        } else if alnum(c) {
            prev_sep = false;
        } else {
            return false;
        }
    }
    true
}

/// Имена, которые нельзя занять: служебные адреса и то, чем удобно выдавать себя за Tabora.
const RESERVED: &[&str] = &[
    "abuse", "account", "accounts", "admin", "administrator", "api", "autoconfig", "autodiscover", "billing", "contact",
    "daemon", "dev", "dmarc", "ftp", "hello", "help", "hostmaster", "imap", "info", "jobs", "legal", "mail", "mailer-daemon",
    "moderator", "mx", "news", "newsletter", "no-reply", "nobody", "noreply", "notification", "notifications", "ns1", "ns2",
    "null", "official", "ops", "owner", "pop", "pop3", "postmaster", "press", "privacy", "root", "sales", "security", "service",
    "services", "smtp", "staff", "support", "sysadmin", "system", "tabora", "team", "tls", "webmaster", "www",
];

pub fn reserved_local(s: &str) -> bool {
    RESERVED.contains(&s) || s.starts_with("tabora-") || s.starts_with("tabora.") || s.starts_with("tabora_")
}

/// Название устройства для списка устройств: без управляющих знаков, не длиннее 64 знаков.
pub fn clean_name(s: &str, fallback: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).take(64).collect();
    let t = t.trim();
    if t.is_empty() { fallback.to_string() } else { t.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_794_330_309_123), "2026-11-10T17:05:09.123Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn local_names() {
        for ok in ["anna", "a.b", "kot.test", "x-y_z9", "abc", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"] {
            assert!(valid_local(ok), "{ok}");
        }
        for bad in ["", "ab", "a", ".abc", "abc.", "a..b", "a.-b", "Abc", "абв", "a b", "a@b", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q"] {
            assert!(!valid_local(bad), "{bad}");
        }
        assert!(reserved_local("postmaster") && reserved_local("tabora-team") && !reserved_local("anna"));
    }

    #[test]
    fn hex_check() {
        assert!(is_hex("00ff", 4) && !is_hex("00FF", 4) && !is_hex("00f", 4) && !is_hex("zz00", 4));
    }
}

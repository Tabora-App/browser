/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! HTTP-интерфейс. Контракт аккаунта задан браузером (account/Account.sys.mjs, HttpBackend):
//! сервер получает не пароль, а хеш входа, который браузер вывел из пароля тяжёлым KDF, и
//! хранит от него только HMAC со своей солью и секретом сервера. Ответы об ошибках —
//! `{ code, message }`, сообщение показывается пользователю как есть.

use crate::db::{self, Alias, DbError, Security, User};
use crate::limit::Limiter;
use crate::mail::{MailError, Stalwart};
use crate::pgp;
use crate::security;
use crate::util::{clean_backup_code, clean_digits, clean_name, hmac256, is_hex, iso, now_ms, open, random, reserved_local, same, sha256, totp, totp_step, valid_local};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const SESSION_TTL_MS: i64 = 180 * 86_400_000;
const NONCE_TTL_MS: i64 = 5 * 60_000;

pub struct App {
    pub domain: String,
    pub mail_host: String,
    pub pool: Pool,
    pub mail: Stalwart,
    pub limiter: Limiter,
    pub pepper: [u8; 32],
    pub totp_key: [u8; 32],
    pub code_key: [u8; 32],
    pub pgp_key: [u8; 32],
    pub mail_daily_cap: u32,
    pub signup_open: bool,
    pub signup_daily_cap: i64,
    pub signup_per_ip_day: u32,
    pub alias_max: usize,
}

pub struct ApiError {
    status: StatusCode,
    pub(crate) code: &'static str,
    message: String,
}

pub(crate) type ApiResult = Result<Json<Value>, ApiError>;

pub(crate) fn err(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError { status, code, message: message.into() }
}

pub(crate) fn bad(code: &'static str, message: impl Into<String>) -> ApiError {
    err(StatusCode::BAD_REQUEST, code, message)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "code": self.code, "message": self.message }))).into_response()
    }
}

impl From<DbError> for ApiError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::Taken => err(StatusCode::CONFLICT, "taken", "Такой адрес уже занят"),
            DbError::Other(text) => {
                eprintln!("база: {text}");
                err(StatusCode::INTERNAL_SERVER_ERROR, "server", "Сервер временно недоступен: повторите позже")
            }
        }
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        DbError::from(e).into()
    }
}

impl From<tokio_postgres::Error> for ApiError {
    fn from(e: tokio_postgres::Error) -> Self {
        DbError::from(e).into()
    }
}

pub(crate) fn mail_err(e: MailError) -> ApiError {
    match e {
        MailError::Taken => err(StatusCode::CONFLICT, "taken", "Такой адрес уже занят"),
        other => {
            eprintln!("почта: {other}");
            err(StatusCode::SERVICE_UNAVAILABLE, "mail-unavailable", "Почтовый сервер не отвечает: повторите позже")
        }
    }
}

pub(crate) fn wait_text(ms: i64) -> String {
    let minutes = (ms + 59_999) / 60_000;
    if minutes <= 1 {
        "минуту".to_string()
    } else if minutes < 120 {
        format!("{minutes} мин")
    } else {
        format!("{} ч", (minutes + 59) / 60)
    }
}

pub(crate) fn too_many(message: impl Into<String>) -> ApiError {
    err(StatusCode::TOO_MANY_REQUESTS, "rate-limited", message)
}

/// Адрес клиента: nginx кладёт в X-Forwarded-For только адрес соединения (за Cloudflare — из
/// CF-Connecting-IP), присланное клиентом значение отбрасывает. Сервер слушает только 127.0.0.1.
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).map(|v| v.split(',').next().unwrap_or("").trim().to_string()).filter(|v| !v.is_empty()).unwrap_or_else(|| "local".to_string())
}

pub(crate) fn parse<'a, T: Deserialize<'a>>(body: &'a Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| bad("bad-request", "Некорректный запрос"))
}

pub(crate) fn local_of(email: &str) -> &str {
    email.split('@').next().unwrap_or("")
}

fn text_field(v: Option<&str>, max: usize) -> String {
    v.unwrap_or("").chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

impl App {
    /// `имя@домен` или просто `имя` → (имя, полный адрес); None, если адрес не наш или имя неверное.
    pub(crate) fn parse_email(&self, input: &str) -> Option<(String, String)> {
        let s = input.trim().to_lowercase();
        let local = match s.split_once('@') {
            Some((l, d)) if d == self.domain => l.to_string(),
            Some(_) => return None,
            None => s,
        };
        valid_local(&local).then(|| (local.clone(), format!("{}@{}", local, self.domain)))
    }

    pub(crate) fn verifier(&self, salt: &[u8], login_hash: &str) -> [u8; 32] {
        hmac256(&self.pepper, &[salt, login_hash.as_bytes()])
    }

    pub(crate) fn window(&self, key: &str, max: u32, window_ms: i64) -> Result<(), ApiError> {
        self.limiter.hit(key, max, window_ms, now_ms()).map_err(|ms| too_many(format!("Слишком много запросов. Повторите через {}", wait_text(ms))))
    }

    fn mail_json(&self, email: &str, secret: &str) -> Value {
        json!({
            "address": email,
            "login": email,
            "password": secret,
            "imap": { "host": self.mail_host, "port": 993, "security": "tls" },
            "smtp": { "host": self.mail_host, "port": 465, "security": "tls" },
        })
    }

    /// Пароль приложения для устройства: прежний отзывается, новый отдаётся клиенту один раз.
    pub(crate) async fn issue_mail(&self, user: &User, device_id: &str, device_name: &str, old: Option<String>) -> Option<Value> {
        if !self.mail.enabled() {
            return None;
        }
        let mail_id = user.mail_id.as_deref()?;
        let local = local_of(&user.email);
        if let Some(old) = old {
            if let Err(e) = self.mail.destroy_app_password(local, &user.public_id, mail_id, &old).await {
                eprintln!("почта: прежний пароль приложения не отозван: {e}");
            }
        }
        let issued = self.mail.create_app_password(local, &user.public_id, mail_id, &format!("Tabora: {device_name}")).await;
        let c = self.pool.get().await.ok()?;
        match issued {
            Ok(p) => {
                if let Err(e) = db::set_device_cred(&c, user.id, device_id, Some(&p.id)).await {
                    eprintln!("база: пароль приложения не записан: {e:?}");
                }
                Some(self.mail_json(&user.email, &p.secret))
            }
            Err(e) => {
                eprintln!("почта: пароль приложения не выдан: {e}");
                let _ = db::set_device_cred(&c, user.id, device_id, None).await;
                None
            }
        }
    }

    /// Отзыв паролей приложений у устройств, оставшихся без сессии.
    async fn revoke_mail(&self, user: &User, devices: &[(String, Option<String>)]) {
        let Some(mail_id) = user.mail_id.as_deref() else { return };
        if !self.mail.enabled() {
            return;
        }
        let Ok(c) = self.pool.get().await else { return };
        for (device_id, cred) in devices {
            let Some(cred) = cred else { continue };
            match self.mail.destroy_app_password(local_of(&user.email), &user.public_id, mail_id, cred).await {
                Ok(()) => {
                    let _ = db::set_device_cred(&c, user.id, device_id, None).await;
                }
                Err(e) => eprintln!("почта: пароль приложения устройства не отозван: {e}"),
            }
        }
    }

    pub(crate) async fn new_session(&self, c: &impl deadpool_postgres::GenericClient, user_id: i64, device_id: &str, now: i64) -> Result<Value, ApiError> {
        let token = format!("tbs_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random::<32>()));
        let expires = now + SESSION_TTL_MS;
        db::create_session(c, &sha256(token.as_bytes()), user_id, device_id, now, expires).await?;
        Ok(json!({ "token": token, "expiresAt": iso(expires) }))
    }

    pub(crate) async fn auth(&self, headers: &HeaderMap) -> Result<(User, String, [u8; 32]), ApiError> {
        let expired = || err(StatusCode::UNAUTHORIZED, "session-expired", "Сессия истекла: войдите в аккаунт заново");
        let token = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::trim).filter(|t| !t.is_empty() && t.len() <= 128).ok_or_else(expired)?;
        let hash = sha256(token.as_bytes());
        let c = self.pool.get().await?;
        let (user, device_id) = db::session(&c, &hash, now_ms()).await?.ok_or_else(expired)?;
        Ok((user, device_id, hash))
    }
}

/// Пауза после очередного неверного кода второго фактора: первые четыре без паузы, дальше
/// 15, 30, 60 минут и так до суток. Шесть цифр перебираются дёшево, поэтому паузы длинные.
fn second_pause(fails: i32) -> i64 {
    if fails < 5 {
        return 0;
    }
    (15 * 60_000i64 << (fails - 5).min(7)).min(86_400_000)
}

impl App {
    /// Повторная проверка пароля перед чувствительной настройкой: хеш входа должен подойти.
    pub(crate) fn reauth(&self, user: &User, login_hash: &str, ip: &str) -> Result<(), ApiError> {
        let now = now_ms();
        let key = format!("pw:{}:{}", user.id, ip);
        let locked = self.limiter.locked(&key, now);
        if locked > 0 {
            return Err(too_many(format!("Слишком много неудачных попыток. Повторите через {}", wait_text(locked))));
        }
        if !is_hex(login_hash, 64) || !same(&self.verifier(&user.salt, login_hash), &user.verifier) {
            self.limiter.fail(&key, now);
            return Err(err(StatusCode::UNAUTHORIZED, "bad-credentials", "Неверный пароль"));
        }
        self.limiter.clear(&key);
        Ok(())
    }

    /// HMAC короткого кода (резервного или из письма): в базе лежит только он.
    pub(crate) fn code_hash(&self, user_id: i64, purpose: &str, code: &str) -> [u8; 32] {
        hmac256(&self.code_key, &[&user_id.to_be_bytes(), purpose.as_bytes(), b"|", code.as_bytes()])
    }

    /// Шаг времени, для которого код приложения верен (текущий или соседний), иначе None.
    pub(crate) fn totp_match(&self, secret: &[u8], code: &str, now: i64) -> Option<i64> {
        let step = totp_step(now);
        [step, step - 1, step + 1].into_iter().find(|s| same(format!("{:06}", totp(secret, *s)).as_bytes(), code.as_bytes()))
    }

    /// Второй фактор для аккаунта с включённой защитой: код приложения (6 цифр) или одноразовый
    /// резервный код. Если защита выключена, проверять нечего. Неверный код считается попыткой
    /// подбора; уже использованный код приложения не принимается, но и попыткой не считается.
    pub(crate) async fn second_factor(&self, c: &impl deadpool_postgres::GenericClient, user: &User, sec: &Security, code: Option<&str>) -> Result<(), ApiError> {
        if !sec.two_factor() {
            return Ok(());
        }
        let Some(code) = code.map(str::trim).filter(|s| !s.is_empty()) else {
            return Err(err(StatusCode::UNAUTHORIZED, "2fa-required", "Введите код двухфакторной защиты"));
        };
        let now = now_ms();
        if sec.totp_locked_until > now {
            return Err(too_many(format!("Слишком много неверных кодов. Повторите через {}", wait_text(sec.totp_locked_until - now))));
        }
        if let Some(digits) = clean_digits(code, 6) {
            let secret = sec.totp_secret.as_deref().and_then(|b| open(&self.totp_key, user.public_id.as_bytes(), b)).ok_or_else(|| {
                eprintln!("двухфакторная защита: секрет {} не расшифрован", user.public_id);
                err(StatusCode::INTERNAL_SERVER_ERROR, "server", "Сервер временно недоступен: повторите позже")
            })?;
            if let Some(step) = self.totp_match(&secret, &digits, now) {
                if db::totp_accept(c, user.id, step).await? {
                    return Ok(());
                }
                return Err(err(StatusCode::UNAUTHORIZED, "bad-2fa", "Этот код уже использован. Дождитесь следующего кода в приложении"));
            }
        } else if let Some(backup) = clean_backup_code(code) {
            if db::use_backup_code(c, user.id, &self.code_hash(user.id, "backup", &backup), now).await? {
                db::totp_clear_fails(c, user.id).await?;
                return Ok(());
            }
        }
        let pause = db::totp_fail(c, user.id, now, second_pause).await?;
        let text = if pause > 0 { format!("Неверный код. Следующая попытка через {}", wait_text(pause)) } else { "Неверный код двухфакторной защиты".to_string() };
        Err(err(StatusCode::UNAUTHORIZED, "bad-2fa", text))
    }

    /// Письмо от сервера: служебный ящик готовится при первом письме, в сутки не больше предела.
    pub(crate) async fn send_mail(&self, to: &str, subject: &str, text: &str) -> Result<(), ApiError> {
        if !self.mail.can_send() {
            return Err(mail_err(MailError::Unavailable("почта выключена".into())));
        }
        self.limiter
            .hit("sysmail", self.mail_daily_cap, 86_400_000, now_ms())
            .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "mail-unavailable", "Сервер сегодня отправил слишком много писем. Повторите завтра"))?;
        if self.mail.needs_sender() {
            let c = self.pool.get().await?;
            let known = db::setting(&c, "system_mail_id").await?;
            if let Some(id) = self.mail.ensure_sender(known.as_deref()).await.map_err(mail_err)? {
                db::set_setting(&c, "system_mail_id", &id).await?;
            }
        }
        self.mail.send_system(to, subject, text).await.map_err(mail_err)
    }

    /// Уведомление на резервный адрес, не задерживая ответ. Нет адреса — нет письма.
    pub(crate) fn notify(self: &Arc<Self>, to: Option<String>, subject: &'static str, text: String) {
        let Some(to) = to else { return };
        let app = self.clone();
        tokio::spawn(async move {
            if let Err(e) = app.send_mail(&to, subject, &text).await {
                eprintln!("уведомление «{subject}» не отправлено: {}", e.code);
            }
        });
    }

    /// Новый пароль после сброса: все устройства выходят из аккаунта и теряют доступ к почте.
    pub(crate) async fn finish_reset(&self, c: &impl deadpool_postgres::GenericClient, user: &User, new_login_hash: &str, now: i64) -> Result<(), ApiError> {
        let salt = random::<16>();
        db::set_password(c, user.id, &salt, &self.verifier(&salt, new_login_hash), 2, now).await?;
        db::delete_sessions(c, user.id, None).await?;
        db::clear_device_creds(c, user.id).await?;
        // отзываются все пароли приложений ящика, включая те, о которых база могла не знать
        if self.mail.enabled() {
            if let Some(mail_id) = user.mail_id.as_deref() {
                if let Err(e) = self.mail.destroy_all_app_passwords(local_of(&user.email), &user.public_id, mail_id).await {
                    eprintln!("почта: пароли приложений после сброса не отозваны: {e}");
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct EmailQuery {
    #[serde(default)]
    email: String,
}

async fn health(State(app): State<Arc<App>>) -> ApiResult {
    let c = app.pool.get().await?;
    c.query_one("SELECT 1", &[]).await?;
    Ok(Json(json!({ "ok": true, "mail": app.mail.enabled() })))
}

async fn available(State(app): State<Arc<App>>, headers: HeaderMap, Query(q): Query<EmailQuery>) -> ApiResult {
    app.window(&format!("avail:{}", client_ip(&headers)), 60, 60_000)?;
    let Some((local, email)) = app.parse_email(&q.email) else { return Ok(Json(json!({ "available": false }))) };
    if reserved_local(&local) {
        return Ok(Json(json!({ "available": false })));
    }
    let c = app.pool.get().await?;
    Ok(Json(json!({ "available": !db::name_taken(&c, &local, &email).await? })))
}

/// Версия хеша входа для адреса. Для неизвестного адреса — текущая: ответ не выдаёт, есть ли аккаунт.
async fn prelogin(State(app): State<Arc<App>>, headers: HeaderMap, Query(q): Query<EmailQuery>) -> ApiResult {
    app.window(&format!("prelogin:{}", client_ip(&headers)), 60, 60_000)?;
    let mut kdf = 2;
    if let Some((_, email)) = app.parse_email(&q.email) {
        let c = app.pool.get().await?;
        if let Some(u) = db::user_by_email(&c, &email).await? {
            kdf = if u.kdf == 1 { 1 } else { 2 };
        }
    }
    Ok(Json(json!({ "kdf": kdf })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    email: String,
    login_hash: String,
    #[serde(default)]
    kdf: i64,
    device_id: String,
    #[serde(default)]
    device_name: String,
}

pub(crate) fn check_device(id: &str) -> Result<(), ApiError> {
    if id.len() < 8 || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(bad("bad-request", "Некорректный запрос: устройство"));
    }
    Ok(())
}

async fn register(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let ip = client_ip(&headers);
    app.window(&format!("ip:{ip}"), 120, 60_000)?;
    if !app.signup_open {
        return Err(err(StatusCode::FORBIDDEN, "signup-closed", "Регистрация временно закрыта"));
    }
    let b: RegisterBody = parse(&body)?;
    let (local, email) = app.parse_email(&b.email).ok_or_else(|| bad("bad-email", "Имя: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание"))?;
    if !is_hex(&b.login_hash, 64) {
        return Err(bad("bad-request", "Некорректный запрос: хеш входа"));
    }
    if b.kdf != 2 {
        return Err(bad("old-client", "Обновите браузер: эта версия защищает пароль по-старому"));
    }
    check_device(&b.device_id)?;
    let device_name = clean_name(&b.device_name, "Устройство");
    let now = now_ms();
    let mut c = app.pool.get().await?;
    if reserved_local(&local) || db::name_taken(&c, &local, &email).await? {
        return Err(DbError::Taken.into());
    }
    app.limiter.hit(&format!("signup:{ip}"), app.signup_per_ip_day, 86_400_000, now).map_err(|_| too_many("С вашего адреса сегодня уже создано несколько аккаунтов. Попробуйте завтра"))?;
    if db::signups_since(&c, now - 86_400_000).await? >= app.signup_daily_cap {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "signup-paused", "Сегодня новых аккаунтов слишком много, регистрация приостановлена до завтра"));
    }

    let public_id = format!("u{}", hex::encode(random::<10>()));
    let salt = random::<16>();
    let verifier = app.verifier(&salt, &b.login_hash);
    let tx = c.transaction().await?;
    let user_id = db::insert_user(&tx, &public_id, &email, &salt, &verifier, 2, now).await?;
    let mut mail_id = None;
    if app.mail.enabled() {
        // ящик создаётся до фиксации: если почтовый сервер отказал, аккаунта без почты не остаётся
        let id = app.mail.create_account(&local, &public_id).await.map_err(mail_err)?;
        db::set_mail_id(&tx, user_id, &id).await?;
        mail_id = Some(id);
    }
    db::upsert_device(&tx, user_id, &b.device_id, &device_name, now).await?;
    let session = app.new_session(&tx, user_id, &b.device_id, now).await?;
    if let Err(e) = tx.commit().await {
        if let Some(id) = &mail_id {
            if let Err(me) = app.mail.destroy_account(id).await {
                eprintln!("почта: ящик {email} остался без аккаунта и не удалён: {me}");
            }
        }
        return Err(e.into());
    }
    let user = User { id: user_id, public_id: public_id.clone(), email: email.clone(), salt: salt.to_vec(), verifier: verifier.to_vec(), kdf: 2, recovery: None, mail_id };
    let mail = app.issue_mail(&user, &b.device_id, &device_name, None).await;
    eprintln!("аккаунт создан: {public_id}");
    Ok(Json(json!({ "userId": public_id, "session": session, "mail": mail })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    email: String,
    login_hash: String,
    device_id: String,
    #[serde(default)]
    device_name: String,
    /// код приложения или резервный код, если у аккаунта включена двухфакторная защита
    #[serde(default)]
    totp: Option<String>,
}

async fn login(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let ip = client_ip(&headers);
    app.window(&format!("login-ip:{ip}"), 30, 60_000)?;
    let b: LoginBody = parse(&body)?;
    let wrong = || err(StatusCode::UNAUTHORIZED, "bad-credentials", "Неверный адрес или пароль");
    check_device(&b.device_id)?;
    let Some((_, email)) = app.parse_email(&b.email) else { return Err(wrong()) };
    if !is_hex(&b.login_hash, 64) {
        return Err(wrong());
    }
    let now = now_ms();
    let key = format!("login:{email}:{ip}");
    let locked = app.limiter.locked(&key, now);
    if locked > 0 {
        return Err(too_many(format!("Слишком много неудачных попыток. Повторите через {}", wait_text(locked))));
    }
    let c = app.pool.get().await?;
    let user = db::user_by_email(&c, &email).await?;
    // для неизвестного адреса считается тот же HMAC: по времени ответа аккаунт не угадать
    let (salt, stored) = match &user {
        Some(u) => (u.salt.clone(), u.verifier.clone()),
        None => (vec![0u8; 16], vec![0u8; 32]),
    };
    let ok = same(&app.verifier(&salt, &b.login_hash), &stored) && user.is_some();
    let Some(user) = user.filter(|_| ok) else {
        app.limiter.fail(&key, now);
        return Err(wrong());
    };
    app.limiter.clear(&key);
    // пароль верен; при включённой защите сессия выдаётся только со вторым фактором
    let sec = db::security(&c, user.id).await?;
    app.second_factor(&c, &user, &sec, b.totp.as_deref()).await?;
    let device_name = clean_name(&b.device_name, "Устройство");
    let old_cred = db::upsert_device(&c, user.id, &b.device_id, &device_name, now).await?;
    let session = app.new_session(&c, user.id, &b.device_id, now).await?;
    drop(c);
    let mail = app.issue_mail(&user, &b.device_id, &device_name, old_cred).await;
    Ok(Json(json!({ "userId": user.public_id, "session": session, "kdf": user.kdf, "mail": mail })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordBody {
    old_login_hash: String,
    new_login_hash: String,
    #[serde(default)]
    kdf: i64,
}

/// Общая часть смены пароля и замены хеша входа: старый хеш должен подойти.
async fn replace_login_hash(app: &App, headers: &HeaderMap, body: &Bytes, wrong_text: &'static str) -> Result<(User, [u8; 32]), ApiError> {
    let (user, _, token_hash) = app.auth(headers).await?;
    let b: PasswordBody = parse(body)?;
    if !is_hex(&b.new_login_hash, 64) || b.kdf != 2 {
        return Err(bad("bad-request", "Некорректный запрос: новый хеш входа"));
    }
    let now = now_ms();
    let key = format!("pw:{}:{}", user.id, client_ip(headers));
    let locked = app.limiter.locked(&key, now);
    if locked > 0 {
        return Err(too_many(format!("Слишком много неудачных попыток. Повторите через {}", wait_text(locked))));
    }
    if !is_hex(&b.old_login_hash, 64) || !same(&app.verifier(&user.salt, &b.old_login_hash), &user.verifier) {
        app.limiter.fail(&key, now);
        return Err(err(StatusCode::UNAUTHORIZED, "bad-credentials", wrong_text));
    }
    app.limiter.clear(&key);
    let salt = random::<16>();
    let c = app.pool.get().await?;
    db::set_password(&c, user.id, &salt, &app.verifier(&salt, &b.new_login_hash), 2, now).await?;
    Ok((user, token_hash))
}

/// Замена хеша входа версии 1 на версию 2 после успешного входа (пароль тот же).
async fn upgrade(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    replace_login_hash(&app, &headers, &body, "Неверный пароль").await?;
    Ok(Json(json!({})))
}

/// Смена пароля: остальные устройства выходят из аккаунта и теряют доступ к почте.
async fn password(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let (user, token_hash) = replace_login_hash(&app, &headers, &body, "Неверный текущий пароль").await?;
    let c = app.pool.get().await?;
    let orphaned = db::delete_sessions(&c, user.id, Some(&token_hash)).await?;
    let backup = db::security(&c, user.id).await?.backup_email;
    drop(c);
    app.revoke_mail(&user, &orphaned).await;
    app.notify(backup, "Tabora: пароль аккаунта изменён", security::notice_text(&user.email, "Пароль аккаунта изменён в браузере, где был выполнен вход. Остальные устройства вышли из аккаунта."));
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryBody {
    recovery_verifier: Option<String>,
}

fn valid_verifier(v: &str) -> bool {
    v.strip_prefix("ed25519:").map(|h| is_hex(h, 64)).unwrap_or(false)
}

async fn recovery(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let (user, _, _) = app.auth(&headers).await?;
    let b: RecoveryBody = parse(&body)?;
    if let Some(v) = &b.recovery_verifier {
        if !valid_verifier(v) {
            return Err(bad("bad-request", "Ключ проверки должен быть открытым ключом Ed25519"));
        }
    }
    let c = app.pool.get().await?;
    db::set_recovery(&c, user.id, b.recovery_verifier.as_deref(), now_ms()).await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct ChallengeBody {
    email: String,
}

/// Одноразовый nonce для сброса пароля. Выдаётся и для неизвестного адреса.
async fn reset_challenge(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let ip = client_ip(&headers);
    app.window(&format!("reset-ip:{ip}"), 10, 3_600_000)?;
    let b: ChallengeBody = parse(&body)?;
    let nonce = hex::encode(random::<16>());
    if let Some((_, email)) = app.parse_email(&b.email) {
        let c = app.pool.get().await?;
        if let Some(u) = db::user_by_email(&c, &email).await? {
            db::put_nonce(&c, u.id, &sha256(nonce.as_bytes()), now_ms() + NONCE_TTL_MS).await?;
        }
    }
    Ok(Json(json!({ "nonce": nonce })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetBody {
    email: String,
    nonce: String,
    recovery_proof: String,
    new_login_hash: String,
    #[serde(default)]
    kdf: i64,
}

/// Подпись запроса сброса: Ed25519(`tabora-reset-v2|адрес|новый хеш входа|nonce`) ключом,
/// выведенным из ключа восстановления; у сервера только открытая половина.
fn verify_reset(verifier: &str, email: &str, new_login_hash: &str, nonce: &str, proof_hex: &str) -> bool {
    let Some(pk_hex) = verifier.strip_prefix("ed25519:") else { return false };
    let (Ok(pk), Ok(sig)) = (hex::decode(pk_hex), hex::decode(proof_hex)) else { return false };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&pk) else { return false };
    let message = format!("tabora-reset-v2|{email}|{new_login_hash}|{nonce}");
    key.verify_strict(message.as_bytes(), &ed25519_dalek::Signature::from_bytes(&sig)).is_ok()
}

/// Сброс забытого пароля. Одного адреса недостаточно: нужна подпись ключом восстановления,
/// свежий nonce и его одноразовость. После сброса все устройства выходят из аккаунта.
async fn reset(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let ip = client_ip(&headers);
    app.window(&format!("reset-ip:{ip}"), 10, 3_600_000)?;
    let b: ResetBody = parse(&body)?;
    let bad_proof = || bad("bad-proof", "Ключ восстановления не подходит к этому аккаунту");
    let stale = || bad("bad-nonce", "Запрос сброса устарел: повторите");
    if !is_hex(&b.new_login_hash, 64) || b.kdf != 2 {
        return Err(bad("bad-request", "Некорректный запрос: новый хеш входа"));
    }
    let Some((_, email)) = app.parse_email(&b.email) else { return Err(bad_proof()) };
    let now = now_ms();
    let c = app.pool.get().await?;
    let Some(user) = db::user_by_email(&c, &email).await? else { return Err(stale()) };
    let nonce = db::take_nonce(&c, user.id).await?;
    let fresh = matches!(&nonce, Some((hash, exp)) if *exp > now && same(hash, &sha256(b.nonce.as_bytes())));
    if !fresh {
        return Err(stale());
    }
    let Some(verifier) = user.recovery.as_deref() else {
        return Err(err(StatusCode::CONFLICT, "no-recovery", "Для аккаунта не зарегистрирован ключ восстановления"));
    };
    if !verify_reset(verifier, &email, &b.new_login_hash, &b.nonce, &b.recovery_proof) {
        return Err(bad_proof());
    }
    app.finish_reset(&c, &user, &b.new_login_hash, now).await?;
    // Ключ восстановления — главный запасной вход: он же снимает двухфакторную защиту, иначе
    // потеря телефона вместе с резервными кодами закрывала бы аккаунт навсегда.
    let backup = db::security(&c, user.id).await?.backup_email;
    let two_factor_off = db::disable_totp(&c, user.id).await?;
    drop(c);
    eprintln!("пароль сброшен ключом восстановления: {}", user.public_id);
    let what = if two_factor_off { "Пароль аккаунта сброшен ключом восстановления, двухфакторная защита выключена. Все устройства вышли из аккаунта." } else { "Пароль аккаунта сброшен ключом восстановления. Все устройства вышли из аккаунта." };
    app.notify(backup, "Tabora: пароль аккаунта сброшен", security::notice_text(&user.email, what));
    Ok(Json(json!({ "twoFactorDisabled": two_factor_off })))
}

async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult {
    let (user, device_id, token_hash) = app.auth(&headers).await?;
    let c = app.pool.get().await?;
    db::delete_session(&c, &token_hash).await?;
    if !db::has_session(&c, user.id, &device_id).await? {
        let cred = db::device_cred(&c, user.id, &device_id).await?;
        drop(c);
        app.revoke_mail(&user, &[(device_id, cred)]).await;
    }
    Ok(Json(json!({})))
}

async fn devices(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let (user, device_id, _) = app.auth(&headers).await?;
    let c = app.pool.get().await?;
    let list = db::devices(&c, user.id).await?;
    Ok(Json(Value::Array(list.iter().map(|d| json!({ "id": d.id, "name": d.name, "at": d.at, "current": d.id == device_id })).collect())))
}

/// Новый пароль приложения для этого устройства (прежний перестаёт действовать): на случай,
/// когда браузер потерял сохранённый доступ к почте.
async fn mail_password(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult {
    let (user, device_id, _) = app.auth(&headers).await?;
    app.window(&format!("mailpw:{}", user.id), 20, 3_600_000)?;
    let c = app.pool.get().await?;
    let old = db::device_cred(&c, user.id, &device_id).await?;
    let name = db::devices(&c, user.id).await?.into_iter().find(|d| d.id == device_id).map(|d| d.name).unwrap_or_else(|| "Устройство".to_string());
    drop(c);
    match app.issue_mail(&user, &device_id, &name, old).await {
        Some(mail) => Ok(Json(json!({ "mail": mail }))),
        None => Err(mail_err(MailError::Unavailable("пароль приложения не выдан".into()))),
    }
}

/* ---- алиасы ---- */

fn alias_json(app: &App, a: &Alias) -> Value {
    json!({
        "id": format!("a{}", a.id),
        "address": format!("{}@{}", a.local, app.domain),
        "site": a.site,
        "space": a.space,
        "by": a.origin,
        "on": a.enabled,
        "created": iso(a.created_at),
    })
}

fn alias_id(raw: &str) -> Result<i64, ApiError> {
    raw.strip_prefix('a').unwrap_or(raw).parse::<i64>().map_err(|_| err(StatusCode::NOT_FOUND, "not-found", "Алиас не найден"))
}

/// Основа адреса из названия сайта: «https://www.Booking.com/x» → «booking».
fn alias_base(site: &str) -> String {
    let s = site.trim().to_lowercase();
    let s = s.split("://").last().unwrap_or("");
    let host = s.split(['/', '?', '#', ':']).next().unwrap_or("");
    let host = host.strip_prefix("www.").unwrap_or(host);
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    // имя сайта — метка перед зоной: booking.com → booking, mail.notion.so → notion
    let name = if labels.len() >= 2 { labels[labels.len() - 2] } else { labels.first().copied().unwrap_or("") };
    let base: String = name.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).take(16).collect();
    if base.len() < 2 { "mail".to_string() } else { base }
}

fn alias_suffix() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789"; // без похожих l/1, o/0
    random::<4>().iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect()
}

/// Список алиасов на почтовом сервере приводится к базе (источник истины — база).
async fn push_aliases(app: &App, c: &impl deadpool_postgres::GenericClient, user: &User) -> Result<(), ApiError> {
    let mail_id = user.mail_id.as_deref().ok_or_else(|| mail_err(MailError::Unavailable("у аккаунта нет ящика".into())))?;
    let list: Vec<(String, bool)> = db::aliases(c, user.id).await?.into_iter().map(|a| (a.local, a.enabled)).collect();
    app.mail.set_aliases(mail_id, &list).await.map_err(mail_err)
}

async fn alias_list(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult {
    let (user, _, _) = app.auth(&headers).await?;
    let c = app.pool.get().await?;
    let list = db::aliases(&c, user.id).await?;
    Ok(Json(Value::Array(list.iter().map(|a| alias_json(&app, a)).collect())))
}

#[derive(Deserialize, Default)]
struct AliasCreate {
    #[serde(default)]
    site: Option<String>,
    #[serde(default)]
    space: Option<String>,
    #[serde(default)]
    by: Option<String>,
}

async fn alias_create(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let (user, _, _) = app.auth(&headers).await?;
    if !app.mail.enabled() || user.mail_id.is_none() {
        return Err(mail_err(MailError::Unavailable("почта выключена".into())));
    }
    let b: AliasCreate = if body.is_empty() { AliasCreate::default() } else { parse(&body)? };
    app.window(&format!("alias:{}", user.id), 30, 3_600_000)?;
    let site = text_field(b.site.as_deref(), 80);
    let space = text_field(b.space.as_deref(), 40);
    let origin = if b.by.as_deref() == Some("agent") { "agent" } else { "manual" };
    let mut c = app.pool.get().await?;
    if db::aliases(&c, user.id).await?.len() >= app.alias_max {
        return Err(err(StatusCode::CONFLICT, "alias-limit", "Алиасов слишком много: удалите ненужные"));
    }
    let base = alias_base(&site);
    let now = now_ms();
    for _ in 0..6 {
        let local = format!("{}-{}", base, alias_suffix());
        if !valid_local(&local) || reserved_local(&local) || db::name_taken(&c, &local, &format!("{}@{}", local, app.domain)).await? {
            continue;
        }
        let tx = c.transaction().await?;
        let alias = match db::insert_alias(&tx, user.id, &local, &site, &space, origin, now).await {
            Ok(a) => a,
            Err(DbError::Taken) => continue,
            Err(e) => return Err(e.into()),
        };
        match push_aliases(&app, &tx, &user).await {
            Ok(()) => {
                tx.commit().await?;
                return Ok(Json(alias_json(&app, &alias)));
            }
            // адрес успел занять кто-то ещё: пробуем другой
            Err(e) if e.code == "taken" => continue,
            Err(e) => return Err(e),
        }
    }
    Err(err(StatusCode::SERVICE_UNAVAILABLE, "server", "Не удалось подобрать свободный адрес: повторите"))
}

#[derive(Deserialize)]
struct AliasUpdate {
    #[serde(default)]
    on: Option<bool>,
    #[serde(default)]
    site: Option<String>,
    #[serde(default)]
    space: Option<String>,
}

async fn alias_update(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let (user, _, _) = app.auth(&headers).await?;
    let id = alias_id(&id)?;
    let b: AliasUpdate = parse(&body)?;
    let site = b.site.as_deref().map(|s| text_field(Some(s), 80));
    let space = b.space.as_deref().map(|s| text_field(Some(s), 40));
    let mut c = app.pool.get().await?;
    let tx = c.transaction().await?;
    let alias = db::update_alias(&tx, user.id, id, b.on, site.as_deref(), space.as_deref()).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not-found", "Алиас не найден"))?;
    if b.on.is_some() {
        push_aliases(&app, &tx, &user).await?;
    }
    tx.commit().await?;
    Ok(Json(alias_json(&app, &alias)))
}

/// Удалённый алиас перестаёт принимать почту навсегда: его адрес больше никому не выдаётся.
async fn alias_delete(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (user, _, _) = app.auth(&headers).await?;
    let id = alias_id(&id)?;
    let mut c = app.pool.get().await?;
    let tx = c.transaction().await?;
    if !db::delete_alias(&tx, user.id, id, now_ms()).await? {
        return Err(err(StatusCode::NOT_FOUND, "not-found", "Алиас не найден"));
    }
    push_aliases(&app, &tx, &user).await?;
    tx.commit().await?;
    Ok(Json(json!({})))
}

async fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "not-found", "Нет такого адреса")
}

async fn no_store(mut res: Response) -> Response {
    res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/account/available", get(available))
        .route("/v1/account/prelogin", get(prelogin))
        .route("/v1/account/register", post(register))
        .route("/v1/account/login", post(login))
        .route("/v1/account/upgrade", post(upgrade))
        .route("/v1/account/password", post(password))
        .route("/v1/account/recovery", post(recovery))
        .route("/v1/account/reset/challenge", post(reset_challenge))
        .route("/v1/account/reset", post(reset))
        .route("/v1/account/reset/email", post(security::reset_email_start))
        .route("/v1/account/reset/email/confirm", post(security::reset_email_confirm))
        .route("/v1/account/security", get(security::overview))
        .route("/v1/account/2fa/setup", post(security::two_factor_setup))
        .route("/v1/account/2fa/enable", post(security::two_factor_enable))
        .route("/v1/account/2fa/disable", post(security::two_factor_disable))
        .route("/v1/account/2fa/codes", post(security::two_factor_codes))
        .route("/v1/account/backup-email", post(security::backup_email_set))
        .route("/v1/account/backup-email/verify", post(security::backup_email_verify))
        .route("/v1/account/backup-email/remove", post(security::backup_email_remove))
        .route("/v1/account/logout", post(logout))
        .route("/v1/account/devices", get(devices))
        .route("/v1/mail/password", post(mail_password))
        .route("/v1/mail/pgp", get(pgp::keys_get).put(pgp::keys_put))
        .route("/.well-known/openpgpkey/hu/:hash", get(pgp::wkd_key))
        .route("/.well-known/openpgpkey/policy", get(pgp::wkd_policy))
        .route("/v1/mail/aliases", get(alias_list).post(alias_create))
        .route("/v1/mail/aliases/:id", patch(alias_update).delete(alias_delete))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::map_response(no_store))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn alias_names() {
        assert_eq!(alias_base("https://www.Booking.com/signup?x=1"), "booking");
        assert_eq!(alias_base("mail.notion.so"), "notion");
        assert_eq!(alias_base("github.com"), "github");
        assert_eq!(alias_base(""), "mail");
        assert_eq!(alias_base("рассылки акций"), "mail");
        let s = alias_suffix();
        assert_eq!(s.len(), 4);
        assert!(valid_local(&format!("{}-{}", alias_base("x.com"), s)));
    }

    #[test]
    fn second_factor_pauses() {
        assert_eq!(second_pause(4), 0);
        assert_eq!(second_pause(5), 15 * 60_000);
        assert_eq!(second_pause(6), 30 * 60_000);
        assert_eq!(second_pause(11), 16 * 3_600_000);
        assert_eq!(second_pause(12), 86_400_000);
        assert_eq!(second_pause(1000), 86_400_000);
        assert_eq!(wait_text(15 * 60_000), "15 мин");
        assert_eq!(wait_text(86_400_000), "24 ч");
    }

    #[test]
    fn reset_signature() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let verifier = format!("ed25519:{}", hex::encode(sk.verifying_key().to_bytes()));
        let hash = "ab".repeat(32);
        let sig = hex::encode(sk.sign(format!("tabora-reset-v2|anna@tabora.app|{hash}|n1").as_bytes()).to_bytes());
        assert!(verify_reset(&verifier, "anna@tabora.app", &hash, "n1", &sig));
        assert!(!verify_reset(&verifier, "anna@tabora.app", &hash, "n2", &sig), "другой nonce");
        assert!(!verify_reset(&verifier, "eve@tabora.app", &hash, "n1", &sig), "другой адрес");
        assert!(!verify_reset("deadbeef", "anna@tabora.app", &hash, "n1", &sig), "ключ прежней схемы");
        assert!(valid_verifier(&verifier) && !valid_verifier("ed25519:zz") && !valid_verifier(&hex::encode([1u8; 32])));
    }
}

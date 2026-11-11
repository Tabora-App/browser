/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! PostgreSQL: схема и запросы. Время везде — миллисекунды с 1970 года (BIGINT).
//! Пароль здесь не хранится: только HMAC от хеша входа, который браузер вывел из пароля.

use deadpool_postgres::{GenericClient, Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use std::time::Duration;
use tokio_postgres::error::SqlState;
use tokio_postgres::{NoTls, Row};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL UNIQUE,
  salt         BYTEA NOT NULL,
  verifier     BYTEA NOT NULL,
  kdf          SMALLINT NOT NULL,
  recovery     TEXT,
  recovery_at  BIGINT,
  mail_id      TEXT,
  created_at   BIGINT NOT NULL,
  password_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  first_seen  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL,
  mail_cred   TEXT,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  BYTEA PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS reset_nonces (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nonce_hash  BYTEA NOT NULL,
  expires_at  BIGINT NOT NULL
);
-- Алиас не удаляется из таблицы никогда: освободившийся адрес мог бы занять другой человек
-- и получать письма, адресованные прежнему владельцу (в том числе ссылки сброса паролей).
CREATE TABLE IF NOT EXISTS aliases (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local       TEXT NOT NULL UNIQUE,
  site        TEXT NOT NULL DEFAULT '',
  space       TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL DEFAULT 'manual',
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  BIGINT NOT NULL,
  deleted_at  BIGINT
);
CREATE INDEX IF NOT EXISTS aliases_user ON aliases(user_id);
-- Имена удалённых ящиков: по той же причине повторно не выдаются.
CREATE TABLE IF NOT EXISTS retired_names (
  local  TEXT PRIMARY KEY,
  at     BIGINT NOT NULL
);
-- Двухфакторная защита входа. Секрет TOTP зашифрован ключом сервера (util::seal), totp_at —
-- когда защита включена (NULL — выключена), totp_step — последний принятый шаг времени (код
-- нельзя использовать дважды). Счётчик неудач живёт в базе, а не в памяти: шесть цифр
-- перебираются дёшево, и перезапуск сервера не должен обнулять паузу.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_fails INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until BIGINT NOT NULL DEFAULT 0;
-- Резервный адрес: сюда приходит код сброса пароля. Записывается только после подтверждения.
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_email_at BIGINT;
-- Одноразовые резервные коды входа: в базе только HMAC от кода.
CREATE TABLE IF NOT EXISTS backup_codes (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  BYTEA NOT NULL,
  used_at    BIGINT,
  PRIMARY KEY (user_id, code_hash)
);
-- Коды из писем: подтверждение резервного адреса (backup-email) и сброс пароля (reset).
-- На назначение — один действующий код; в базе только HMAC от него.
CREATE TABLE IF NOT EXISTS mail_codes (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  address     TEXT NOT NULL,
  code_hash   BYTEA NOT NULL,
  expires_at  BIGINT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, purpose)
);
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- Ключи шифрования почты (OpenPGP). Открытый ключ публикуется в каталоге (wkd_hash — имя записи).
-- blob — закрытый ключ, зашифрованный браузером ключом данных; wrap_pw и wrap_rk — ключ данных,
-- зашифрованный ключом из пароля и из ключа восстановления. Все три блока сверху запечатаны
-- ключом сервера. rev растёт с каждым изменением: по нему отсекаются одновременные записи.
CREATE TABLE IF NOT EXISTS mail_keys (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev          BIGINT NOT NULL DEFAULT 0,
  fingerprint  TEXT,
  public_key   BYTEA,
  wkd_hash     TEXT,
  blob         BYTEA,
  wrap_pw      BYTEA,
  wrap_rk      BYTEA,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_keys_wkd ON mail_keys (wkd_hash);
"#;

#[derive(Debug)]
pub enum DbError {
    Taken,
    Other(String),
}

impl From<tokio_postgres::Error> for DbError {
    fn from(e: tokio_postgres::Error) -> Self {
        if e.code() == Some(&SqlState::UNIQUE_VIOLATION) {
            DbError::Taken
        } else {
            DbError::Other(e.to_string())
        }
    }
}

impl From<deadpool_postgres::PoolError> for DbError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        DbError::Other(e.to_string())
    }
}

pub fn pool(url: &str) -> Result<Pool, String> {
    let cfg: tokio_postgres::Config = url.parse().map_err(|e| format!("строка подключения к базе: {e}"))?;
    let mgr = Manager::from_config(cfg, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    Pool::builder(mgr)
        .max_size(8)
        .runtime(Runtime::Tokio1)
        .wait_timeout(Some(Duration::from_secs(5)))
        .create_timeout(Some(Duration::from_secs(5)))
        .build()
        .map_err(|e| format!("пул подключений: {e}"))
}

#[derive(Clone, Debug)]
pub struct User {
    pub id: i64,
    pub public_id: String,
    pub email: String,
    pub salt: Vec<u8>,
    pub verifier: Vec<u8>,
    pub kdf: i16,
    pub recovery: Option<String>,
    pub mail_id: Option<String>,
}

const USER_COLS: &str = "id, public_id, email, salt, verifier, kdf, recovery, mail_id";

fn user(row: &Row) -> User {
    User {
        id: row.get(0),
        public_id: row.get(1),
        email: row.get(2),
        salt: row.get(3),
        verifier: row.get(4),
        kdf: row.get(5),
        recovery: row.get(6),
        mail_id: row.get(7),
    }
}

pub async fn user_by_email<C: GenericClient>(c: &C, email: &str) -> Result<Option<User>, DbError> {
    Ok(c.query_opt(&format!("SELECT {USER_COLS} FROM users WHERE email = $1"), &[&email]).await?.as_ref().map(user))
}

/// Занято ли имя: ящиком, алиасом (в том числе удалённым) или именем удалённого ящика.
pub async fn name_taken<C: GenericClient>(c: &C, local: &str, email: &str) -> Result<bool, DbError> {
    let row = c
        .query_one(
            "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1) OR EXISTS(SELECT 1 FROM aliases WHERE local = $2) OR EXISTS(SELECT 1 FROM retired_names WHERE local = $2)",
            &[&email, &local],
        )
        .await?;
    Ok(row.get(0))
}

pub async fn insert_user<C: GenericClient>(c: &C, public_id: &str, email: &str, salt: &[u8], verifier: &[u8], kdf: i16, now: i64) -> Result<i64, DbError> {
    let row = c
        .query_one(
            "INSERT INTO users (public_id, email, salt, verifier, kdf, created_at, password_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
            &[&public_id, &email, &salt, &verifier, &kdf, &now],
        )
        .await?;
    Ok(row.get(0))
}

pub async fn set_mail_id<C: GenericClient>(c: &C, user_id: i64, mail_id: &str) -> Result<(), DbError> {
    c.execute("UPDATE users SET mail_id = $2 WHERE id = $1", &[&user_id, &mail_id]).await?;
    Ok(())
}

pub async fn set_password<C: GenericClient>(c: &C, user_id: i64, salt: &[u8], verifier: &[u8], kdf: i16, now: i64) -> Result<(), DbError> {
    c.execute("UPDATE users SET salt = $2, verifier = $3, kdf = $4, password_at = $5 WHERE id = $1", &[&user_id, &salt, &verifier, &kdf, &now]).await?;
    Ok(())
}

pub async fn set_recovery<C: GenericClient>(c: &C, user_id: i64, verifier: Option<&str>, now: i64) -> Result<(), DbError> {
    c.execute("UPDATE users SET recovery = $2, recovery_at = $3 WHERE id = $1", &[&user_id, &verifier, &now]).await?;
    Ok(())
}

pub async fn signups_since<C: GenericClient>(c: &C, since: i64) -> Result<i64, DbError> {
    Ok(c.query_one("SELECT count(*) FROM users WHERE created_at > $1", &[&since]).await?.get(0))
}

/// Устройство входит: запись создаётся или обновляется. Возвращает прежний пароль приложения,
/// если он был (его надо отозвать на почтовом сервере).
pub async fn upsert_device<C: GenericClient>(c: &C, user_id: i64, device_id: &str, name: &str, now: i64) -> Result<Option<String>, DbError> {
    let old: Option<String> = c
        .query_opt("SELECT mail_cred FROM devices WHERE user_id = $1 AND device_id = $2", &[&user_id, &device_id])
        .await?
        .and_then(|r| r.get(0));
    c.execute(
        "INSERT INTO devices (user_id, device_id, name, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (user_id, device_id) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen",
        &[&user_id, &device_id, &name, &now],
    )
    .await?;
    Ok(old)
}

pub async fn set_device_cred<C: GenericClient>(c: &C, user_id: i64, device_id: &str, cred: Option<&str>) -> Result<(), DbError> {
    c.execute("UPDATE devices SET mail_cred = $3 WHERE user_id = $1 AND device_id = $2", &[&user_id, &device_id, &cred]).await?;
    Ok(())
}

pub async fn clear_device_creds<C: GenericClient>(c: &C, user_id: i64) -> Result<(), DbError> {
    c.execute("UPDATE devices SET mail_cred = NULL WHERE user_id = $1", &[&user_id]).await?;
    Ok(())
}

pub async fn device_cred<C: GenericClient>(c: &C, user_id: i64, device_id: &str) -> Result<Option<String>, DbError> {
    Ok(c.query_opt("SELECT mail_cred FROM devices WHERE user_id = $1 AND device_id = $2", &[&user_id, &device_id]).await?.and_then(|r| r.get(0)))
}

pub struct Device {
    pub id: String,
    pub name: String,
    pub at: i64,
}

pub async fn devices<C: GenericClient>(c: &C, user_id: i64) -> Result<Vec<Device>, DbError> {
    let rows = c.query("SELECT device_id, name, last_seen FROM devices WHERE user_id = $1 ORDER BY last_seen DESC", &[&user_id]).await?;
    Ok(rows.iter().map(|r| Device { id: r.get(0), name: r.get(1), at: r.get(2) }).collect())
}

pub async fn create_session<C: GenericClient>(c: &C, token_hash: &[u8], user_id: i64, device_id: &str, now: i64, expires: i64) -> Result<(), DbError> {
    c.execute(
        "INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen) VALUES ($1, $2, $3, $4, $5, $4)",
        &[&token_hash, &user_id, &device_id, &now, &expires],
    )
    .await?;
    Ok(())
}

/// Действующая сессия: пользователь и устройство. Отметка «был в сети» обновляется не чаще раза в час.
pub async fn session<C: GenericClient>(c: &C, token_hash: &[u8], now: i64) -> Result<Option<(User, String)>, DbError> {
    let row = c
        .query_opt(
            "SELECT u.id, u.public_id, u.email, u.salt, u.verifier, u.kdf, u.recovery, u.mail_id, s.device_id, s.last_seen
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2",
            &[&token_hash, &now],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let u = user(&row);
    let device_id: String = row.get(8);
    let last_seen: i64 = row.get(9);
    if now - last_seen > 3_600_000 {
        c.execute("UPDATE sessions SET last_seen = $2 WHERE token_hash = $1", &[&token_hash, &now]).await?;
        c.execute("UPDATE devices SET last_seen = $3 WHERE user_id = $1 AND device_id = $2", &[&u.id, &device_id, &now]).await?;
    }
    Ok(Some((u, device_id)))
}

pub async fn delete_session<C: GenericClient>(c: &C, token_hash: &[u8]) -> Result<(), DbError> {
    c.execute("DELETE FROM sessions WHERE token_hash = $1", &[&token_hash]).await?;
    Ok(())
}

/// Завершить сессии пользователя, кроме одной (None — все). Возвращает устройства, у которых
/// не осталось ни одной сессии: их пароли приложений надо отозвать.
pub async fn delete_sessions<C: GenericClient>(c: &C, user_id: i64, keep: Option<&[u8]>) -> Result<Vec<(String, Option<String>)>, DbError> {
    match keep {
        Some(k) => c.execute("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", &[&user_id, &k]).await?,
        None => c.execute("DELETE FROM sessions WHERE user_id = $1", &[&user_id]).await?,
    };
    let rows = c
        .query(
            "SELECT d.device_id, d.mail_cred FROM devices d WHERE d.user_id = $1
             AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = d.user_id AND s.device_id = d.device_id)",
            &[&user_id],
        )
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

pub async fn has_session<C: GenericClient>(c: &C, user_id: i64, device_id: &str) -> Result<bool, DbError> {
    Ok(c.query_one("SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id = $1 AND device_id = $2)", &[&user_id, &device_id]).await?.get(0))
}

pub async fn purge_expired<C: GenericClient>(c: &C, now: i64) -> Result<u64, DbError> {
    let n = c.execute("DELETE FROM sessions WHERE expires_at <= $1", &[&now]).await?;
    c.execute("DELETE FROM reset_nonces WHERE expires_at <= $1", &[&now]).await?;
    c.execute("DELETE FROM mail_codes WHERE expires_at <= $1", &[&now]).await?;
    c.execute("UPDATE users SET totp_pending = NULL, totp_pending_at = NULL WHERE totp_pending_at IS NOT NULL AND totp_pending_at <= $1", &[&(now - 3_600_000)]).await?;
    Ok(n)
}

pub async fn put_nonce<C: GenericClient>(c: &C, user_id: i64, hash: &[u8], expires: i64) -> Result<(), DbError> {
    c.execute(
        "INSERT INTO reset_nonces (user_id, nonce_hash, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET nonce_hash = EXCLUDED.nonce_hash, expires_at = EXCLUDED.expires_at",
        &[&user_id, &hash, &expires],
    )
    .await?;
    Ok(())
}

/// Одноразовый nonce: забирается из базы при любой попытке, даже неудачной.
pub async fn take_nonce<C: GenericClient>(c: &C, user_id: i64) -> Result<Option<(Vec<u8>, i64)>, DbError> {
    Ok(c.query_opt("DELETE FROM reset_nonces WHERE user_id = $1 RETURNING nonce_hash, expires_at", &[&user_id]).await?.map(|r| (r.get(0), r.get(1))))
}

#[derive(Clone, Debug)]
pub struct Alias {
    pub id: i64,
    pub local: String,
    pub site: String,
    pub space: String,
    pub origin: String,
    pub enabled: bool,
    pub created_at: i64,
}

fn alias(row: &Row) -> Alias {
    Alias { id: row.get(0), local: row.get(1), site: row.get(2), space: row.get(3), origin: row.get(4), enabled: row.get(5), created_at: row.get(6) }
}

/// Действующие алиасы пользователя (без удалённых), новые сверху.
pub async fn aliases<C: GenericClient>(c: &C, user_id: i64) -> Result<Vec<Alias>, DbError> {
    let rows = c
        .query("SELECT id, local, site, space, origin, enabled, created_at FROM aliases WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC", &[&user_id])
        .await?;
    Ok(rows.iter().map(alias).collect())
}

pub async fn insert_alias<C: GenericClient>(c: &C, user_id: i64, local: &str, site: &str, space: &str, origin: &str, now: i64) -> Result<Alias, DbError> {
    let row = c
        .query_one(
            "INSERT INTO aliases (user_id, local, site, space, origin, created_at) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, local, site, space, origin, enabled, created_at",
            &[&user_id, &local, &site, &space, &origin, &now],
        )
        .await?;
    Ok(alias(&row))
}

pub async fn update_alias<C: GenericClient>(c: &C, user_id: i64, id: i64, enabled: Option<bool>, site: Option<&str>, space: Option<&str>) -> Result<Option<Alias>, DbError> {
    let row = c
        .query_opt(
            "UPDATE aliases SET enabled = COALESCE($3, enabled), site = COALESCE($4, site), space = COALESCE($5, space)
             WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL RETURNING id, local, site, space, origin, enabled, created_at",
            &[&user_id, &id, &enabled, &site, &space],
        )
        .await?;
    Ok(row.as_ref().map(alias))
}

pub async fn delete_alias<C: GenericClient>(c: &C, user_id: i64, id: i64, now: i64) -> Result<bool, DbError> {
    Ok(c.execute("UPDATE aliases SET deleted_at = $3, enabled = FALSE WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL", &[&user_id, &id, &now]).await? > 0)
}

/* ---- двухфакторная защита, резервный адрес, коды из писем ---- */

#[derive(Clone, Debug, Default)]
pub struct Security {
    pub totp_secret: Option<Vec<u8>>,
    pub totp_at: Option<i64>,
    pub totp_pending: Option<Vec<u8>>,
    pub totp_pending_at: Option<i64>,
    pub totp_locked_until: i64,
    pub backup_email: Option<String>,
    pub backup_email_at: Option<i64>,
}

impl Security {
    pub fn two_factor(&self) -> bool {
        self.totp_at.is_some() && self.totp_secret.is_some()
    }
}

pub async fn security<C: GenericClient>(c: &C, user_id: i64) -> Result<Security, DbError> {
    let r = c
        .query_one(
            "SELECT totp_secret, totp_at, totp_pending, totp_pending_at, totp_locked_until, backup_email, backup_email_at FROM users WHERE id = $1",
            &[&user_id],
        )
        .await?;
    Ok(Security {
        totp_secret: r.get(0),
        totp_at: r.get(1),
        totp_pending: r.get(2),
        totp_pending_at: r.get(3),
        totp_locked_until: r.get(4),
        backup_email: r.get(5),
        backup_email_at: r.get(6),
    })
}

pub async fn set_totp_pending<C: GenericClient>(c: &C, user_id: i64, blob: &[u8], now: i64) -> Result<(), DbError> {
    c.execute("UPDATE users SET totp_pending = $2, totp_pending_at = $3 WHERE id = $1", &[&user_id, &blob, &now]).await?;
    Ok(())
}

/// Секрет, ждавший подтверждения, становится действующим; step — шаг времени принятого кода.
pub async fn enable_totp<C: GenericClient>(c: &C, user_id: i64, now: i64, step: i64) -> Result<bool, DbError> {
    let n = c
        .execute(
            "UPDATE users SET totp_secret = totp_pending, totp_at = $2, totp_step = $3, totp_pending = NULL, totp_pending_at = NULL, totp_fails = 0, totp_locked_until = 0
             WHERE id = $1 AND totp_pending IS NOT NULL AND totp_at IS NULL",
            &[&user_id, &now, &step],
        )
        .await?;
    Ok(n > 0)
}

pub async fn disable_totp<C: GenericClient>(c: &C, user_id: i64) -> Result<bool, DbError> {
    let n = c
        .execute(
            "UPDATE users SET totp_secret = NULL, totp_at = NULL, totp_step = 0, totp_pending = NULL, totp_pending_at = NULL, totp_fails = 0, totp_locked_until = 0 WHERE id = $1 AND totp_at IS NOT NULL",
            &[&user_id],
        )
        .await?;
    c.execute("DELETE FROM backup_codes WHERE user_id = $1", &[&user_id]).await?;
    Ok(n > 0)
}

/// Код принят, если его шаг времени новее последнего принятого: второй раз тот же код не пройдёт.
pub async fn totp_accept<C: GenericClient>(c: &C, user_id: i64, step: i64) -> Result<bool, DbError> {
    Ok(c.execute("UPDATE users SET totp_step = $2, totp_fails = 0, totp_locked_until = 0 WHERE id = $1 AND totp_step < $2", &[&user_id, &step]).await? > 0)
}

/// Неудачная проверка второго фактора: счётчик растёт, пауза считается от него.
pub async fn totp_fail<C: GenericClient>(c: &C, user_id: i64, now: i64, pause: fn(i32) -> i64) -> Result<i64, DbError> {
    let fails: i32 = c.query_one("UPDATE users SET totp_fails = totp_fails + 1 WHERE id = $1 RETURNING totp_fails", &[&user_id]).await?.get(0);
    let until = now + pause(fails);
    c.execute("UPDATE users SET totp_locked_until = $2 WHERE id = $1", &[&user_id, &until]).await?;
    Ok(until - now)
}

pub async fn totp_clear_fails<C: GenericClient>(c: &C, user_id: i64) -> Result<(), DbError> {
    c.execute("UPDATE users SET totp_fails = 0, totp_locked_until = 0 WHERE id = $1", &[&user_id]).await?;
    Ok(())
}

pub async fn replace_backup_codes<C: GenericClient>(c: &C, user_id: i64, hashes: &[[u8; 32]]) -> Result<(), DbError> {
    c.execute("DELETE FROM backup_codes WHERE user_id = $1", &[&user_id]).await?;
    for h in hashes {
        c.execute("INSERT INTO backup_codes (user_id, code_hash) VALUES ($1, $2)", &[&user_id, &&h[..]]).await?;
    }
    Ok(())
}

/// Резервный код одноразовый: отметка «использован» ставится тем же запросом, что и проверка.
pub async fn use_backup_code<C: GenericClient>(c: &C, user_id: i64, hash: &[u8], now: i64) -> Result<bool, DbError> {
    Ok(c.execute("UPDATE backup_codes SET used_at = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL", &[&user_id, &hash, &now]).await? > 0)
}

pub async fn backup_codes_left<C: GenericClient>(c: &C, user_id: i64) -> Result<i64, DbError> {
    Ok(c.query_one("SELECT count(*) FROM backup_codes WHERE user_id = $1 AND used_at IS NULL", &[&user_id]).await?.get(0))
}

pub async fn set_backup_email<C: GenericClient>(c: &C, user_id: i64, address: Option<&str>, now: i64) -> Result<(), DbError> {
    let at = address.map(|_| now);
    c.execute("UPDATE users SET backup_email = $2, backup_email_at = $3 WHERE id = $1", &[&user_id, &address, &at]).await?;
    Ok(())
}

/// Имя принадлежит действующему алиасу этого пользователя.
pub async fn alias_owned<C: GenericClient>(c: &C, user_id: i64, local: &str) -> Result<bool, DbError> {
    Ok(c.query_one("SELECT EXISTS(SELECT 1 FROM aliases WHERE user_id = $1 AND local = $2 AND deleted_at IS NULL)", &[&user_id, &local]).await?.get(0))
}

pub struct MailCode {
    pub address: String,
    pub code_hash: Vec<u8>,
    pub expires_at: i64,
    pub attempts: i32,
}

/// Новый код заменяет прежний того же назначения.
pub async fn put_mail_code<C: GenericClient>(c: &C, user_id: i64, purpose: &str, address: &str, hash: &[u8], expires: i64, now: i64) -> Result<(), DbError> {
    c.execute(
        "INSERT INTO mail_codes (user_id, purpose, address, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, purpose) DO UPDATE SET address = EXCLUDED.address, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = EXCLUDED.created_at",
        &[&user_id, &purpose, &address, &hash, &expires, &now],
    )
    .await?;
    Ok(())
}

pub async fn mail_code<C: GenericClient>(c: &C, user_id: i64, purpose: &str) -> Result<Option<MailCode>, DbError> {
    Ok(c
        .query_opt("SELECT address, code_hash, expires_at, attempts FROM mail_codes WHERE user_id = $1 AND purpose = $2", &[&user_id, &purpose])
        .await?
        .map(|r| MailCode { address: r.get(0), code_hash: r.get(1), expires_at: r.get(2), attempts: r.get(3) }))
}

pub async fn mail_code_attempt<C: GenericClient>(c: &C, user_id: i64, purpose: &str) -> Result<i32, DbError> {
    Ok(c.query_opt("UPDATE mail_codes SET attempts = attempts + 1 WHERE user_id = $1 AND purpose = $2 RETURNING attempts", &[&user_id, &purpose]).await?.map(|r| r.get(0)).unwrap_or(i32::MAX))
}

pub async fn delete_mail_code<C: GenericClient>(c: &C, user_id: i64, purpose: &str) -> Result<(), DbError> {
    c.execute("DELETE FROM mail_codes WHERE user_id = $1 AND purpose = $2", &[&user_id, &purpose]).await?;
    Ok(())
}

/* ---- ключи шифрования почты ---- */

#[derive(Clone, Debug, Default)]
pub struct MailKeys {
    pub rev: i64,
    pub fingerprint: Option<String>,
    pub public_key: Option<Vec<u8>>,
    pub wkd_hash: Option<String>,
    pub blob: Option<Vec<u8>>,
    pub wrap_pw: Option<Vec<u8>>,
    pub wrap_rk: Option<Vec<u8>>,
    pub updated_at: i64,
}

pub async fn mail_keys<C: GenericClient>(c: &C, user_id: i64) -> Result<Option<MailKeys>, DbError> {
    let row = c.query_opt("SELECT rev, fingerprint, public_key, wkd_hash, blob, wrap_pw, wrap_rk, updated_at FROM mail_keys WHERE user_id = $1", &[&user_id]).await?;
    Ok(row.map(|r| MailKeys { rev: r.get(0), fingerprint: r.get(1), public_key: r.get(2), wkd_hash: r.get(3), blob: r.get(4), wrap_pw: r.get(5), wrap_rk: r.get(6), updated_at: r.get(7) }))
}

/// Запись ключей для изменения: строка пользователя блокируется до конца транзакции, поэтому
/// два одновременных сохранения идут по очереди (в том числе самое первое, когда записи ещё нет).
pub async fn mail_keys_for_update<C: GenericClient>(c: &C, user_id: i64) -> Result<Option<MailKeys>, DbError> {
    c.query_opt("SELECT id FROM users WHERE id = $1 FOR UPDATE", &[&user_id]).await?;
    mail_keys(c, user_id).await
}

pub async fn save_mail_keys<C: GenericClient>(c: &C, user_id: i64, k: &MailKeys) -> Result<(), DbError> {
    c.execute(
        "INSERT INTO mail_keys (user_id, rev, fingerprint, public_key, wkd_hash, blob, wrap_pw, wrap_rk, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (user_id) DO UPDATE SET rev = EXCLUDED.rev, fingerprint = EXCLUDED.fingerprint, public_key = EXCLUDED.public_key, wkd_hash = EXCLUDED.wkd_hash, \
         blob = EXCLUDED.blob, wrap_pw = EXCLUDED.wrap_pw, wrap_rk = EXCLUDED.wrap_rk, updated_at = EXCLUDED.updated_at",
        &[&user_id, &k.rev, &k.fingerprint, &k.public_key, &k.wkd_hash, &k.blob, &k.wrap_pw, &k.wrap_rk, &k.updated_at],
    )
    .await?;
    Ok(())
}

pub async fn public_key_by_wkd<C: GenericClient>(c: &C, hash: &str) -> Result<Option<Vec<u8>>, DbError> {
    Ok(c.query_opt("SELECT public_key FROM mail_keys WHERE wkd_hash = $1 AND public_key IS NOT NULL", &[&hash]).await?.map(|r| r.get(0)))
}

pub async fn setting<C: GenericClient>(c: &C, key: &str) -> Result<Option<String>, DbError> {
    Ok(c.query_opt("SELECT value FROM settings WHERE key = $1", &[&key]).await?.map(|r| r.get(0)))
}

pub async fn set_setting<C: GenericClient>(c: &C, key: &str, value: &str) -> Result<(), DbError> {
    c.execute("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", &[&key, &value]).await?;
    Ok(())
}

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

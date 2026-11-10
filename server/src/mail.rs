/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Почтовый сервер Stalwart: ящики, пароли приложений и алиасы через его объекты JMAP.
//!
//! Ящик создаётся служебным ключом (право только на учётки пользователей). Основной пароль
//! ящика выводится из секрета сервера и номера пользователя, нигде не хранится и клиентам не
//! отдаётся: им сервер входит в ящик с 127.0.0.1, чтобы выдать или отозвать пароль приложения.
//! Каждое устройство получает свой пароль приложения: он подходит к IMAP и SMTP, отзывается
//! при выходе с устройства и ничего не говорит о пароле аккаунта.

use crate::util::hmac256;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::OnceCell;

#[derive(Debug)]
pub enum MailError {
    /// адрес уже занят ящиком или алиасом
    Taken,
    /// почтовый сервер не принял учётные данные
    Unauthorized,
    /// почтовый сервер не отвечает
    Unavailable(String),
    /// почтовый сервер отклонил запрос
    Rejected(String),
}

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailError::Taken => write!(f, "адрес занят"),
            MailError::Unauthorized => write!(f, "вход отклонён"),
            MailError::Unavailable(e) => write!(f, "недоступен: {e}"),
            MailError::Rejected(e) => write!(f, "отклонено: {e}"),
        }
    }
}

enum Auth<'a> {
    Service,
    User { login: &'a str, password: &'a str },
}

pub struct Stalwart {
    base: String,
    api_key: String,
    domain: String,
    mail_key: [u8; 32],
    quota_bytes: u64,
    http: reqwest::Client,
    domain_id: OnceCell<String>,
}

pub struct AppPassword {
    pub id: String,
    pub secret: String,
}

impl Stalwart {
    pub fn new(base: &str, api_key: &str, domain: &str, mail_key: [u8; 32], quota_bytes: u64) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("клиент HTTP");
        Self { base: base.trim_end_matches('/').to_string(), api_key: api_key.to_string(), domain: domain.to_string(), mail_key, quota_bytes, http, domain_id: OnceCell::new() }
    }

    /// Без адреса или ключа почтовая часть выключена: аккаунты работают, ящики не создаются.
    pub fn enabled(&self) -> bool {
        !self.base.is_empty() && !self.api_key.is_empty()
    }

    fn primary_password(&self, public_id: &str) -> String {
        hex::encode(hmac256(&self.mail_key, &[public_id.as_bytes()]))
    }

    fn loopback() -> Value {
        json!({ "127.0.0.1": true, "::1": true })
    }

    async fn jmap(&self, auth: Auth<'_>, method: &str, args: Value) -> Result<Value, MailError> {
        let body = json!({
            "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            "methodCalls": [[method, args, "c0"]],
        });
        let req = self.http.post(format!("{}/jmap", self.base)).json(&body);
        let req = match auth {
            Auth::Service => req.bearer_auth(&self.api_key),
            Auth::User { login, password } => req.basic_auth(login, Some(password)),
        };
        let res = req.send().await.map_err(|e| MailError::Unavailable(e.to_string()))?;
        let status = res.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(MailError::Unauthorized);
        }
        if !status.is_success() {
            return Err(MailError::Unavailable(format!("HTTP {}", status.as_u16())));
        }
        let v: Value = res.json().await.map_err(|e| MailError::Unavailable(e.to_string()))?;
        let first = v.get("methodResponses").and_then(|r| r.get(0)).and_then(Value::as_array).ok_or_else(|| MailError::Rejected("пустой ответ".into()))?;
        let name = first.first().and_then(Value::as_str).unwrap_or("");
        let resp = first.get(1).cloned().unwrap_or(Value::Null);
        if name == "error" {
            return Err(MailError::Rejected(resp.to_string()));
        }
        for key in ["notCreated", "notUpdated", "notDestroyed"] {
            if let Some(obj) = resp.get(key).and_then(Value::as_object) {
                if let Some(err) = obj.values().next() {
                    if err.get("type").and_then(Value::as_str) == Some("primaryKeyViolation") {
                        return Err(MailError::Taken);
                    }
                    return Err(MailError::Rejected(err.to_string()));
                }
            }
        }
        Ok(resp)
    }

    async fn domain_id(&self) -> Result<&str, MailError> {
        self.domain_id
            .get_or_try_init(|| async {
                let ids = self.jmap(Auth::Service, "x:Domain/query", json!({})).await?;
                let list = self.jmap(Auth::Service, "x:Domain/get", json!({ "ids": ids.get("ids").cloned().unwrap_or(Value::Null) })).await?;
                list.get("list")
                    .and_then(Value::as_array)
                    .and_then(|l| l.iter().find(|d| d.get("name").and_then(Value::as_str) == Some(self.domain.as_str())))
                    .and_then(|d| d.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .ok_or_else(|| MailError::Rejected(format!("домена {} нет на почтовом сервере", self.domain)))
            })
            .await
            .map(String::as_str)
    }

    /// Новый ящик `local@домен`. Возвращает его номер на почтовом сервере.
    pub async fn create_account(&self, local: &str, public_id: &str) -> Result<String, MailError> {
        let domain_id = self.domain_id().await?;
        let args = json!({ "create": { "u": {
            "@type": "User",
            "name": local,
            "domainId": domain_id,
            "roles": { "@type": "User" },
            "description": "Tabora: ящик пользователя",
            "credentials": { "0": { "@type": "Password", "secret": self.primary_password(public_id), "allowedIps": Self::loopback() } },
            "quotas": { "maxDiskQuota": self.quota_bytes },
        } } });
        let r = self.jmap(Auth::Service, "x:Account/set", args).await?;
        r.pointer("/created/u/id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| MailError::Rejected("нет номера созданного ящика".into()))
    }

    pub async fn destroy_account(&self, mail_id: &str) -> Result<(), MailError> {
        self.jmap(Auth::Service, "x:Account/set", json!({ "destroy": [mail_id] })).await.map(|_| ())
    }

    /// Основной пароль выставляется заново (после смены секрета сервера прежний не подойдёт).
    async fn reset_primary(&self, mail_id: &str, public_id: &str) -> Result<(), MailError> {
        let patch = json!({ "update": { mail_id: {
            "credentials/0": { "@type": "Password", "secret": self.primary_password(public_id), "allowedIps": Self::loopback() },
        } } });
        self.jmap(Auth::Service, "x:Account/set", patch).await.map(|_| ())
    }

    /// Запрос от имени владельца ящика; если основной пароль не подошёл, он выставляется заново.
    async fn as_user(&self, local: &str, public_id: &str, mail_id: &str, method: &str, args: Value) -> Result<Value, MailError> {
        let login = format!("{}@{}", local, self.domain);
        let password = self.primary_password(public_id);
        match self.jmap(Auth::User { login: &login, password: &password }, method, args.clone()).await {
            Err(MailError::Unauthorized) => {
                self.reset_primary(mail_id, public_id).await?;
                self.jmap(Auth::User { login: &login, password: &password }, method, args).await
            }
            other => other,
        }
    }

    /// Пароль приложения для одного устройства. Секрет почтовый сервер показывает один раз.
    pub async fn create_app_password(&self, local: &str, public_id: &str, mail_id: &str, description: &str) -> Result<AppPassword, MailError> {
        let args = json!({ "create": { "p": { "description": description, "permissions": { "@type": "Inherit" } } } });
        let r = self.as_user(local, public_id, mail_id, "x:AppPassword/set", args).await?;
        let id = r.pointer("/created/p/id").and_then(Value::as_str);
        let secret = r.pointer("/created/p/secret").and_then(Value::as_str);
        match (id, secret) {
            (Some(id), Some(secret)) => Ok(AppPassword { id: id.to_string(), secret: secret.to_string() }),
            _ => Err(MailError::Rejected("почтовый сервер не вернул пароль приложения".into())),
        }
    }

    pub async fn destroy_app_password(&self, local: &str, public_id: &str, mail_id: &str, cred_id: &str) -> Result<(), MailError> {
        match self.as_user(local, public_id, mail_id, "x:AppPassword/set", json!({ "destroy": [cred_id] })).await {
            // уже отозван — это и требовалось
            Ok(_) | Err(MailError::Rejected(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Отзыв всех паролей приложений ящика (сброс пароля аккаунта: все устройства выходят).
    pub async fn destroy_all_app_passwords(&self, local: &str, public_id: &str, mail_id: &str) -> Result<usize, MailError> {
        let list = self.as_user(local, public_id, mail_id, "x:AppPassword/get", json!({ "ids": null })).await?;
        let ids: Vec<Value> = list.get("list").and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.get("id").cloned()).collect()).unwrap_or_default();
        if ids.is_empty() {
            return Ok(0);
        }
        let n = ids.len();
        self.as_user(local, public_id, mail_id, "x:AppPassword/set", json!({ "destroy": ids })).await?;
        Ok(n)
    }

    /// Алиасы ящика целиком: (имя до @, включён ли). Выключенный алиас письма не принимает.
    pub async fn set_aliases(&self, mail_id: &str, aliases: &[(String, bool)]) -> Result<(), MailError> {
        let domain_id = self.domain_id().await?;
        let mut map = serde_json::Map::new();
        for (i, (local, enabled)) in aliases.iter().enumerate() {
            map.insert(i.to_string(), json!({ "name": local, "domainId": domain_id, "enable": enabled }));
        }
        self.jmap(Auth::Service, "x:Account/set", json!({ "update": { mail_id: { "aliases": Value::Object(map) } } })).await.map(|_| ())
    }
}

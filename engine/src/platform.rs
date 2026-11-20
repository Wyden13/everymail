//! Every target difference, so nothing above this module is aware of the target: native hosts run
//! tasks on a multi-threaded runtime, so tasks, sinks, callbacks and what they share must be `Send`;
//! the browser has one thread. The clock, the timer, HTTP and the device's keyboard come from the
//! host. Bodies are served by a custom URI scheme on desktop and by the Frontend's Service Worker
//! on web.

use std::{future::Future, pin::Pin, sync::Arc};

/// What may be shared with the host's threads: everything `Send + Sync` natively, anything in the
/// browser.
#[cfg(not(target_arch = "wasm32"))]
pub trait Threaded: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> Threaded for T {}
#[cfg(target_arch = "wasm32")]
pub trait Threaded {}
#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> Threaded for T {}

/// Shares `value` between the engine's handles and its tasks: across threads natively, where it is
/// `Threaded`, and on the browser's one thread, where it need not be `Send`.
pub fn shared<T: Threaded>(value: T) -> Arc<T> {
    Arc::new(value)
}

#[cfg(not(target_arch = "wasm32"))]
pub type Task = Pin<Box<dyn Future<Output = ()> + Send>>;
#[cfg(target_arch = "wasm32")]
pub type Task = Pin<Box<dyn Future<Output = ()>>>;

#[cfg(not(target_arch = "wasm32"))]
pub type Sink = Box<dyn Fn(Vec<u8>) + Send>;
#[cfg(target_arch = "wasm32")]
pub type Sink = Box<dyn Fn(Vec<u8>)>;

/// Runs a task to completion on the host's executor.
pub type Spawn = fn(Task);

#[cfg(not(target_arch = "wasm32"))]
pub type Callback = Box<dyn FnOnce() + Send>;
#[cfg(target_arch = "wasm32")]
pub type Callback = Box<dyn FnOnce()>;

/// The device's clock: milliseconds since 1970.
pub fn wall_ms() -> i64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as i64
    }
}

/// Calls `callback` once, `ms` milliseconds from now.
pub fn after(ms: u64, callback: Callback) {
    #[cfg(not(target_arch = "wasm32"))]
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        callback();
    });
    #[cfg(target_arch = "wasm32")]
    {
        use wasm_bindgen::prelude::*;
        #[wasm_bindgen]
        extern "C" {
            #[wasm_bindgen(js_name = setTimeout)]
            fn set_timeout(callback: &JsValue, ms: f64) -> JsValue;
        }
        set_timeout(&Closure::once_into_js(callback), ms as f64);
    }
}

/// Where a sandboxed iframe loads a message body from. Desktop: the `body` scheme registered by
/// the Tauri host, which Windows and Android webviews reach as `http://body.localhost`. Web: a
/// same-origin path the Service Worker answers with `WebEngine::body`. What follows the origin is
/// the body request: the message id and the theme.
pub fn body_url(message_id: &str, theme: crate::proto::ui::v1::Theme) -> String {
    #[cfg(target_arch = "wasm32")]
    let origin = "/body/";
    #[cfg(all(
        not(target_arch = "wasm32"),
        any(target_os = "windows", target_os = "android")
    ))]
    let origin = "http://body.localhost/";
    #[cfg(all(
        not(target_arch = "wasm32"),
        not(any(target_os = "windows", target_os = "android"))
    ))]
    let origin = "body://localhost/";
    format!("{origin}{}", crate::body::request(message_id, theme))
}

/// POSTs protobuf bytes, with the session's bearer token when there is one, and returns the
/// response body of a 200 answer; anything else is `None`.
pub async fn post(url: &str, body: Vec<u8>, bearer: Option<&str>) -> Option<Vec<u8>> {
    let request = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/proto")
        .body(body);
    let request = match bearer {
        Some(token) => request.bearer_auth(token),
        None => request,
    };
    let response = request
        .send()
        .await
        .ok()
        .filter(|r| r.status() == reqwest::StatusCode::OK)?;
    response.bytes().await.ok().map(|b| b.to_vec())
}

/// Where the provider's page sends the browser back to once the user has signed in.
pub enum Return {
    /// The web app: the page opens in this tab, and the Backend keeps the session in a cookie.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        allow(dead_code, reason = "native returns through the loopback")
    )]
    SameTab,
    /// Desktop: the browser posts the handoff to this device's loopback.
    #[cfg_attr(
        target_arch = "wasm32",
        allow(dead_code, reason = "the browser returns in the same tab")
    )]
    Loopback(Listener),
}

/// How this target finishes a sign-in, or `None` when it cannot listen for it.
#[cfg(target_arch = "wasm32")]
pub fn sign_in_return() -> Option<Return> {
    Some(Return::SameTab)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn sign_in_return() -> Option<Return> {
    loopback::bind().map(Return::Loopback)
}

/// What the sign-in listener heard before it stopped.
#[cfg_attr(
    target_arch = "wasm32",
    allow(dead_code, reason = "the browser runs no listener")
)]
pub enum Heard {
    Handoff(String),
    /// The attempt outlived the Backend's 600 seconds.
    Expired,
}

#[cfg(not(target_arch = "wasm32"))]
pub use loopback::Listener;

/// The browser never runs a listener.
#[cfg(target_arch = "wasm32")]
pub enum Listener {}

#[cfg(target_arch = "wasm32")]
impl Listener {
    pub fn port(&self) -> u16 {
        match *self {}
    }

    pub fn serve(self, _: impl Fn() -> bool + 'static, _: impl FnOnce(Heard) + 'static) {
        match self {}
    }
}

/// The one local server the engine runs: 127.0.0.1 only, for one sign-in attempt, until the
/// browser posts the handoff to `/`.
#[cfg(not(target_arch = "wasm32"))]
mod loopback {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        time::{Duration, Instant},
    };

    use super::Heard;

    /// The Backend's attempt life.
    const ATTEMPT: Duration = Duration::from_secs(600);
    const POLL: Duration = Duration::from_millis(100);
    /// A request carrying a handoff is far smaller than this.
    const MAX_REQUEST: usize = 8 * 1024;

    pub struct Listener(TcpListener);

    pub fn bind() -> Option<Listener> {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        listener.set_nonblocking(true).ok()?;
        Some(Listener(listener))
    }

    impl Listener {
        pub fn port(&self) -> u16 {
            self.0.local_addr().map_or(0, |address| address.port())
        }

        /// Listens on its own thread until it hears the handoff or the attempt expires, and
        /// tells `heard`; stops without a word once `keep_going` is false.
        pub fn serve(
            self,
            keep_going: impl Fn() -> bool + Send + 'static,
            heard: impl FnOnce(Heard) + Send + 'static,
        ) {
            std::thread::spawn(move || {
                let until = Instant::now() + ATTEMPT;
                while keep_going() {
                    if Instant::now() >= until {
                        return heard(Heard::Expired);
                    }
                    match self.0.accept() {
                        Ok((stream, _)) => {
                            if let Some(handoff) = answer(stream) {
                                return heard(Heard::Handoff(handoff));
                            }
                        }
                        Err(_) => std::thread::sleep(POLL),
                    }
                }
            });
        }
    }

    /// Reads one request and answers it: the handoff, or `None` for anything else.
    fn answer(mut stream: TcpStream) -> Option<String> {
        stream.set_nonblocking(false).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut request = Vec::new();
        let mut chunk = [0; 1024];
        let parsed = loop {
            match parse(&request) {
                Parsed::Incomplete if request.len() < MAX_REQUEST => {}
                Parsed::Incomplete => break Parsed::Refused,
                done => break done,
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break Parsed::Refused,
                Ok(n) => request.extend_from_slice(&chunk[..n]),
            }
        };
        let (status, text, handoff) = match parsed {
            Parsed::Handoff(handoff) => (
                "200 OK",
                "Signed in. You can return to EveryMail.",
                Some(handoff),
            ),
            Parsed::Incomplete | Parsed::Refused => {
                ("400 Bad Request", "This is not an EveryMail sign-in.", None)
            }
        };
        // The browser that brought a handoff has delivered it whether or not it reads the answer.
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
            text.len()
        );
        handoff
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Parsed {
        Incomplete,
        Handoff(String),
        Refused,
    }

    /// One request as read so far: complete only once the body its `Content-Length` names is in.
    /// Only `POST /` with a form body whose `handoff` is base64url is a handoff.
    fn parse(request: &[u8]) -> Parsed {
        let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
            return Parsed::Incomplete;
        };
        let Ok(head) = std::str::from_utf8(&request[..end]) else {
            return Parsed::Refused;
        };
        let mut lines = head.split("\r\n");
        if !lines
            .next()
            .is_some_and(|line| line.starts_with("POST / HTTP/1."))
        {
            return Parsed::Refused;
        }
        let Some(length) = lines
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        else {
            return Parsed::Refused;
        };
        let body = &request[end + 4..];
        if body.len() < length {
            return Parsed::Incomplete;
        }
        std::str::from_utf8(&body[..length])
            .ok()
            .and_then(|form| {
                form.split('&')
                    .find_map(|pair| pair.strip_prefix("handoff="))
            })
            .filter(|handoff| {
                !handoff.is_empty()
                    && handoff
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map_or(Parsed::Refused, |handoff| Parsed::Handoff(handoff.into()))
    }

    #[cfg(test)]
    mod tests {
        use super::{Parsed, parse};

        fn post(path: &str, body: &str) -> Vec<u8> {
            format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
            .into_bytes()
        }

        #[test]
        fn only_a_form_post_to_the_root_with_a_base64url_handoff_is_heard() {
            assert_eq!(
                parse(&post("/", "handoff=aB3-_x")),
                Parsed::Handoff("aB3-_x".into())
            );
            assert_eq!(
                parse(&post("/", "other=1&handoff=abc")),
                Parsed::Handoff("abc".into())
            );
            for refused in [
                post("/favicon.ico", "handoff=abc"),
                post("/", "handoff="),
                post("/", "handoff=a%2Bb"),
                post("/", "claim=abc"),
                b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".to_vec(),
                b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nhandoff=abc".to_vec(),
            ] {
                assert_eq!(parse(&refused), Parsed::Refused);
            }
        }

        #[test]
        fn a_request_is_read_until_its_body_is_in() {
            let whole = post("/", "handoff=abc");
            assert_eq!(parse(&whole[..10]), Parsed::Incomplete);
            assert_eq!(parse(&whole[..whole.len() - 1]), Parsed::Incomplete);
        }
    }
}

/// The session's bearer token, which desktop keeps in the operating system's keychain. The web
/// app holds none: its session is an HttpOnly cookie.
pub mod credential {
    #[cfg(not(target_arch = "wasm32"))]
    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new("dev.everyai.everymail", "session").ok()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn load() -> Option<String> {
        entry()?.get_password().ok()
    }

    /// Whether the keychain took it.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn save(token: &str) -> bool {
        entry().is_some_and(|entry| entry.set_password(token).is_ok())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn forget() {
        // Nothing stored is nothing to forget.
        if let Some(entry) = entry() {
            let _ = entry.delete_credential();
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn load() -> Option<String> {
        None
    }

    #[cfg(target_arch = "wasm32")]
    pub fn save(_: &str) -> bool {
        false
    }

    #[cfg(target_arch = "wasm32")]
    pub fn forget() {}
}

/// The new mail shortcut as this device's keyboard writes it.
pub fn new_mail_shortcut() -> &'static str {
    if apple() { "⌘N" } else { "Ctrl+N" }
}

#[cfg(not(target_arch = "wasm32"))]
fn apple() -> bool {
    cfg!(any(target_os = "macos", target_os = "ios"))
}

/// The browser's platform, from the Worker's navigator: `userAgentData.platform` where it exists
/// ("macOS"), `platform` elsewhere ("MacIntel", "iPhone").
#[cfg(target_arch = "wasm32")]
fn apple() -> bool {
    use js_sys::Reflect;
    use wasm_bindgen::JsValue;
    let get = |of: &JsValue, key: &str| {
        Reflect::get(of, &JsValue::from_str(key))
            .ok()
            .filter(|v| !v.is_undefined() && !v.is_null())
    };
    let Some(navigator) = get(&js_sys::global(), "navigator") else {
        return false;
    };
    let platform = get(&navigator, "userAgentData")
        .and_then(|data| get(&data, "platform"))
        .or_else(|| get(&navigator, "platform"))
        .and_then(|p| p.as_string())
        .unwrap_or_default()
        .to_lowercase();
    ["mac", "iphone", "ipad"]
        .iter()
        .any(|name| platform.contains(name))
}

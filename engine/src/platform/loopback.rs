//! The loopback listener a native sign-in returns to: the Backend's callback page POSTs the
//! handoff to `http://127.0.0.1:<port>/`. It is the one local server the engine runs, so anything
//! on the machine can reach it: other programs, and every web page open in the browser.
//!
//! - Bound to 127.0.0.1 on a port the OS picks, before the port is named to the Backend, with no
//!   reuse option set. Linux and macOS then let no other socket bind 127.0.0.1:<port> (that needs
//!   SO_REUSEPORT on both sockets); Windows, since Server 2003, refuses a second bind of the same
//!   specific address to any user, so SO_EXCLUSIVEADDRUSE would add nothing there.
//! - Only a request a browser makes from the Backend's own page is a candidate: the exact method,
//!   path, `Host` (the DNS rebinding defence), content type and `Origin`, and one `handoff` field of
//!   the Backend's token shape. Anything else gets a refusal with no detail and listening goes on,
//!   so no page can end a sign-in.
//! - The listener cannot tell a real handoff from a guessed one; only the Backend can. The wait
//!   yields each candidate together with the listener, and the caller waits again when the Backend
//!   does not accept it.
//! - One connection at a time, a bounded request and a deadline for each connection, so nothing
//!   can make it hold memory or hang past the attempt.

use std::{io, net::Ipv4Addr, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket},
    sync::oneshot,
    time::{Instant, sleep_until, timeout},
};

/// Request line and headers, terminator included. A browser's form POST is well under 2 KiB; the
/// rest leaves room for cookies the user's own local tools set on 127.0.0.1.
const HEAD_LIMIT: usize = 16 * 1024;
const FIELD: &[u8] = b"handoff=";
/// 32 random bytes in base64url without padding, as `randomToken` in `backend/src/session.ts`.
const HANDOFF_LEN: usize = 43;
/// The only body accepted: the one field. Base64url needs no form encoding.
const BODY_LEN: usize = FIELD.len() + HANDOFF_LEN;
/// A browser writes the whole request at once; anything slower is not one.
const CONNECTION_TIME: Duration = Duration::from_secs(5);
/// Connections the OS holds while one is served.
const BACKLOG: u32 = 16;
const PAGE: &str = "Return to EveryMail to finish signing in.\n";

/// A well-formed handoff: a secret, so it has no `Debug` and leaves only through `into_string`.
pub struct Handoff(String);

impl Handoff {
    pub fn into_string(self) -> String {
        self.0
    }
}

/// Listening for one sign-in attempt. Waiting consumes it; a candidate hands it back.
pub struct Loopback {
    listener: TcpListener,
    port: u16,
    expect: Expect,
    ends_at: Instant,
    ended: oneshot::Receiver<()>,
}

/// Held by whoever may end the attempt: dropping it ends the wait.
pub struct End {
    _sender: oneshot::Sender<()>,
}

/// How a wait finishes.
pub enum Wait {
    /// A well-formed handoff arrived. If the Backend does not accept it, wait again on the listener.
    Candidate(Handoff, Loopback),
    /// The `End` was dropped.
    Ended,
    /// The attempt's lifetime passed.
    TimedOut,
    /// The OS stopped accepting connections, for example out of file descriptors.
    Failed,
}

/// What a request must carry to be a candidate.
struct Expect {
    host: String,
    origin: String,
}

impl Loopback {
    /// Binds 127.0.0.1 on a free port for an attempt that lives `lifetime`, accepting posts only
    /// from a page of `origin` (the Backend's, as `https://host`). Async because the socket joins
    /// the runtime the engine's tasks run on.
    pub async fn bind(origin: String, lifetime: Duration) -> io::Result<(Loopback, End)> {
        // A fresh socket carries no reuse option; `TcpListener::bind` would set SO_REUSEADDR on Unix
        let socket = TcpSocket::new_v4()?;
        socket.bind((Ipv4Addr::LOCALHOST, 0).into())?;
        let listener = socket.listen(BACKLOG)?;
        let port = listener.local_addr()?.port();
        let (end, ended) = oneshot::channel();
        let loopback = Loopback {
            listener,
            port,
            expect: Expect {
                host: format!("{}:{port}", Ipv4Addr::LOCALHOST),
                origin,
            },
            ends_at: Instant::now() + lifetime,
            ended,
        };
        Ok((loopback, End { _sender: end }))
    }

    /// The port to name in `StartSignIn`.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Serves connections until one brings a candidate, the `End` is dropped or the lifetime passes.
    pub async fn wait(mut self) -> Wait {
        let served = tokio::select! {
            served = serve(&self.listener, &self.expect) => served,
            _ = &mut self.ended => return Wait::Ended,
            () = sleep_until(self.ends_at) => return Wait::TimedOut,
        };
        match served {
            Some(handoff) => Wait::Candidate(handoff, self),
            None => Wait::Failed,
        }
    }
}

/// Answers connections one at a time until one carries a candidate; `None` when accepting fails.
async fn serve(listener: &TcpListener, expect: &Expect) -> Option<Handoff> {
    loop {
        let mut stream = match listener.accept().await {
            Ok((stream, peer)) if peer.ip().is_loopback() => stream,
            Ok(_) => continue,
            // The peer gave up before it was accepted: its loss, not the listener's
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionRefused
                ) =>
            {
                continue;
            }
            Err(_) => return None,
        };
        if let Ok(Some(handoff)) = timeout(CONNECTION_TIME, answer(&mut stream, expect)).await {
            return Some(handoff);
        }
    }
}

/// Reads one request and answers it: the page for a candidate, a refusal for anything else.
async fn answer(stream: &mut tokio::net::TcpStream, expect: &Expect) -> Option<Handoff> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    let request = loop {
        match parse(&bytes, expect) {
            Request::Incomplete => {}
            done => break done,
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break Request::Refused,
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
        }
    };
    let (handoff, response) = match request {
        Request::Handoff(handoff) => (Some(handoff), response("200 OK", PAGE)),
        Request::Incomplete | Request::Refused => (None, response("400 Bad Request", "")),
    };
    // A browser that leaves before reading the page has still delivered the handoff
    let _ = stream.write_all(response.as_bytes()).await;
    handoff
}

/// Every answer is plain text that nothing may cache, sniff, load into or pass on as a referrer.
fn response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    )
}

/// What the bytes read so far from one connection amount to.
enum Request {
    Incomplete,
    Refused,
    Handoff(Handoff),
}

fn parse(bytes: &[u8], expect: &Expect) -> Request {
    let scanned = &bytes[..bytes.len().min(HEAD_LIMIT)];
    let Some(end) = scanned.windows(4).position(|w| w == b"\r\n\r\n") else {
        return if bytes.len() >= HEAD_LIMIT {
            Request::Refused
        } else {
            Request::Incomplete
        };
    };
    if !std::str::from_utf8(&bytes[..end]).is_ok_and(|head| accepted_head(head, expect)) {
        return Request::Refused;
    }
    let body = &bytes[end + 4..];
    if body.len() < BODY_LEN {
        return Request::Incomplete;
    }
    match body.strip_prefix(FIELD) {
        Some(token)
            if body.len() == BODY_LEN
                && token
                    .iter()
                    .all(|&b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            // Only base64url bytes, so the conversion cannot fail
            Request::Handoff(Handoff(String::from_utf8_lossy(token).into_owned()))
        }
        _ => Request::Refused,
    }
}

/// Whether a head is the one a candidate carries, announcing the one body accepted.
fn accepted_head(head: &str, expect: &Expect) -> bool {
    let mut lines = head.split("\r\n");
    if lines.next() != Some("POST / HTTP/1.1") {
        return false;
    }
    let [mut host, mut origin, mut content_type, mut length] = [None; 4];
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        // A name with whitespace is malformed, and a folded line starts with it
        if name.is_empty() || name.contains([' ', '\t']) {
            return false;
        }
        let slot = match name.to_ascii_lowercase().as_str() {
            "host" => &mut host,
            "origin" => &mut origin,
            "content-type" => &mut content_type,
            "content-length" => &mut length,
            // A browser sends a form's body with a length; a chunked one is not a browser's form
            "transfer-encoding" => return false,
            _ => continue,
        };
        // Twice is never a browser, and could mean two readings of one request
        if slot.replace(value.trim_matches([' ', '\t'])).is_some() {
            return false;
        }
    }
    host == Some(expect.host.as_str())
        && origin == Some(expect.origin.as_str())
        && content_type == Some("application/x-www-form-urlencoded")
        && length == Some(BODY_LEN.to_string().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-_9";

    fn expect() -> Expect {
        Expect {
            host: "127.0.0.1:4100".into(),
            origin: "https://everymail.example".into(),
        }
    }

    fn request(head: &str, body: &str) -> Vec<u8> {
        format!("{head}\r\n\r\n{body}").into_bytes()
    }

    fn browser(replace: (&str, &str)) -> Vec<u8> {
        let head = [
            "POST / HTTP/1.1",
            "Host: 127.0.0.1:4100",
            "Content-Length: 51",
            "Origin: https://everymail.example",
            "Content-Type: application/x-www-form-urlencoded",
            "Referer: https://everymail.example/",
            "Cookie: dev=1",
        ]
        .join("\r\n")
        .replace(replace.0, replace.1);
        request(&head, &format!("handoff={TOKEN}"))
    }

    fn refused(bytes: &[u8]) -> bool {
        matches!(parse(bytes, &expect()), Request::Refused)
    }

    #[test]
    fn a_browser_post_from_the_backend_page_is_a_candidate() {
        let Request::Handoff(handoff) = parse(&browser(("", "")), &expect()) else {
            panic!("not a candidate");
        };
        assert_eq!(handoff.into_string(), TOKEN);
        // Header names are case-insensitive and values may carry surrounding whitespace
        let loose = browser(("Host: 127.0.0.1:4100", "hOST:\t127.0.0.1:4100 "));
        assert!(matches!(parse(&loose, &expect()), Request::Handoff(_)));
    }

    #[test]
    fn waits_for_the_rest_of_the_head_and_the_body() {
        let full = browser(("", ""));
        for cut in [0, 10, full.len() - 52, full.len() - 1] {
            assert!(matches!(
                parse(&full[..cut], &expect()),
                Request::Incomplete
            ));
        }
    }

    #[test]
    fn refuses_anything_but_the_exact_request_line() {
        for line in [
            "GET / HTTP/1.1",
            "OPTIONS / HTTP/1.1",
            "post / HTTP/1.1",
            "POST /x HTTP/1.1",
            "POST /?handoff=x HTTP/1.1",
            "POST / HTTP/1.0",
            "POST  / HTTP/1.1",
        ] {
            assert!(refused(&browser(("POST / HTTP/1.1", line))), "{line}");
        }
    }

    #[test]
    fn refuses_another_host_origin_or_content_type() {
        for (from, to) in [
            // DNS rebinding: a page of another name that resolves to 127.0.0.1
            ("Host: 127.0.0.1:4100", "Host: attacker.example:4100"),
            ("Host: 127.0.0.1:4100", "Host: localhost:4100"),
            ("Host: 127.0.0.1:4100", "Host: 127.0.0.1:4101"),
            ("Host: 127.0.0.1:4100", "X: y"),
            ("Origin: https://everymail.example", "Origin: null"),
            (
                "Origin: https://everymail.example",
                "Origin: https://attacker.example",
            ),
            (
                "Origin: https://everymail.example",
                "Origin: http://everymail.example",
            ),
            ("Origin: https://everymail.example", "X: y"),
            (
                "x-www-form-urlencoded",
                "x-www-form-urlencoded; charset=utf-8",
            ),
            ("application/x-www-form-urlencoded", "text/plain"),
            ("application/x-www-form-urlencoded", "multipart/form-data"),
        ] {
            assert!(refused(&browser((from, to))), "{to}");
        }
    }

    #[test]
    fn refuses_malformed_or_ambiguous_headers() {
        for (from, to) in [
            ("Cookie: dev=1", "Cookie: dev=1\r\nHost: 127.0.0.1:4100"),
            (
                "Cookie: dev=1",
                "Cookie: dev=1\r\nTransfer-Encoding: chunked",
            ),
            ("Cookie: dev=1", "Cookie: dev=1\r\n folded"),
            ("Cookie: dev=1", "no colon"),
            ("Host:", "Host :"),
            ("Content-Length: 51", "Content-Length: 52"),
            ("Content-Length: 51", "Content-Length: +51"),
        ] {
            assert!(refused(&browser((from, to))), "{to}");
        }
    }

    #[test]
    fn refuses_a_body_other_than_one_handoff_of_the_token_shape() {
        let head = |len: usize| {
            format!(
                "POST / HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nOrigin: https://everymail.example\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {len}"
            )
        };
        let short = &TOKEN[..42];
        for body in [
            format!("handoff={short}="),
            format!("handoff={short}+"),
            format!("handoff={short}%"),
            format!("handof={TOKEN}x"),
            format!("x={short}AAAAAA"),
        ] {
            assert!(refused(&request(&head(body.len()), &body)), "{body}");
        }
        // More bytes than announced
        assert!(refused(&request(
            &head(BODY_LEN),
            &format!("handoff={TOKEN}&x")
        )));
    }

    #[test]
    fn refuses_a_head_past_its_limit() {
        let cookie = format!("Cookie: {}", "a".repeat(HEAD_LIMIT));
        assert!(refused(&browser(("Cookie: dev=1", &cookie))));
        assert!(refused(&vec![b'a'; HEAD_LIMIT]));
        assert!(matches!(
            parse(&vec![b'a'; HEAD_LIMIT - 1], &expect()),
            Request::Incomplete
        ));
    }

    #[tokio::test]
    async fn a_refused_request_leaves_the_wait_to_the_handoff_or_the_end() {
        let origin = "https://everymail.example";
        let (loopback, end) = Loopback::bind(origin.into(), Duration::from_secs(600))
            .await
            .unwrap();
        let port = loopback.port();
        let waiting = tokio::spawn(loopback.wait());
        let exchange = |request: String| async move {
            let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        };
        let refusal = exchange(format!(
            "OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        ))
        .await;
        assert!(refusal.starts_with("HTTP/1.1 400 "), "{refusal}");
        let page = exchange(format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\n\
             Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 51\r\n\r\n\
             handoff={TOKEN}"
        ))
        .await;
        assert!(page.starts_with("HTTP/1.1 200 "), "{page}");
        assert!(page.ends_with(PAGE));
        let Wait::Candidate(handoff, loopback) = waiting.await.unwrap() else {
            panic!("no candidate");
        };
        assert_eq!(handoff.into_string(), TOKEN);
        drop(end);
        assert!(matches!(loopback.wait().await, Wait::Ended));
    }
}

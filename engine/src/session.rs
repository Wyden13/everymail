//! Sign-in and the session, with the Backend's `AuthService`. The web app returns from the
//! provider's page in the same tab and holds its session as a cookie; desktop opens the page in the
//! system browser, hears the handoff on a loopback port, collects a bearer token and keeps it in
//! the keychain. Which one is the platform's choice.

use std::time::Duration;

use prost::Message;

use crate::{
    Engine, Input,
    action::Auth,
    backend::{Update, Work},
    live::{Attempt, SignInAnswer, SignInStep},
    platform::{self, Return, Wait},
    proto::api::v1::{
        FinishSignInRequest, FinishSignInResponse, GetSessionRequest, GetSessionResponse, Google,
        Loopback, Microsoft, Native, SignOutRequest, SignOutResponse, SignedIn, StartSignInRequest,
        StartSignInResponse, Web,
        finish_sign_in_response::Outcome,
        get_session_response,
        native::Return as NativeReturn,
        start_sign_in_request::{Client, Provider},
    },
    world::Identity,
};

const DID_NOT_START: &str = "The sign-in could not start. Try again";
const DID_NOT_FINISH: &str = "The sign-in did not finish. Try again";

/// The origin of the Backend's URL, which its sign-in page's form carries as `Origin`. `None`
/// for a URL without one: an opaque origin serializes as `null`, which any page can send.
pub(crate) fn origin(url: &str) -> Option<String> {
    let origin = reqwest::Url::parse(url).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Whether `url` is the provider's own sign-in page over https: the only page the engine opens in
/// the browser or hands to the Frontend.
fn provider_page(url: &str, provider: Identity) -> bool {
    let host = match provider {
        Identity::Google => "accounts.google.com",
        Identity::Microsoft => "login.microsoftonline.com",
    };
    reqwest::Url::parse(url)
        .is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some(host) && u.port().is_none())
}

impl Engine {
    /// Opens the session at launch: the stored credential, then, when the replica is signed out,
    /// the session the Backend may already hold for this device.
    pub(crate) fn open_session(&self, signed_out: bool) {
        let engine = self.clone();
        (self.0.spawn)(Box::pin(async move {
            engine.hold(platform::credential::load());
            if signed_out {
                engine.find_session().await;
            }
        }));
    }

    /// Runs under the state lock, so a cancel drops the listener's `End` before any later input.
    pub(crate) fn authenticate(&self, auth: Auth) {
        let engine = self.clone();
        match auth {
            Auth::SignIn(attempt, provider) => (self.0.spawn)(Box::pin(async move {
                engine.sign_in(attempt, provider).await;
            })),
            Auth::Cancel => *self.listening() = None,
            Auth::SignOut => (self.0.spawn)(Box::pin(async move { engine.sign_out().await })),
        }
    }

    fn listening(&self) -> std::sync::MutexGuard<'_, Option<platform::End>> {
        self.0
            .listening
            .lock()
            .expect("a sign-in listener holder panicked")
    }

    fn credential(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.0
            .credential
            .lock()
            .expect("a credential holder panicked")
    }

    fn hold(&self, credential: Option<String>) {
        *self.credential() = credential;
    }

    /// Calls an `AuthService` method with `bearer`: the answer of a 200, or the status of another
    /// answer, or `None` when none came or it did not decode.
    async fn call<A: Default + Message>(
        &self,
        method: &str,
        request: impl Message,
        bearer: Option<&str>,
    ) -> Result<A, Option<u16>> {
        let url = format!("{}{method}", self.0.auth_url);
        let body = platform::post(&url, request.encode_to_vec(), bearer).await?;
        A::decode(body.as_slice()).map_err(|_| None)
    }

    /// Calls an `AuthService` method with the session's credential.
    async fn auth<A: Default + Message>(
        &self,
        method: &str,
        request: impl Message,
    ) -> Result<A, Option<u16>> {
        let credential = self.credential().clone();
        self.call(method, request, credential.as_deref()).await
    }

    /// Tells the attempt how far it has come; it lands only while that attempt is waited on.
    fn answer(&self, attempt: Attempt, answer: SignInAnswer) {
        // A failed read leaves the view as it was; the next input sends one.
        let _ = self.dispatch(Input::SignIn(attempt, answer));
    }

    fn fail(&self, attempt: Attempt, reason: &str) {
        self.answer(attempt, SignInAnswer::Failed(reason.into()));
    }

    /// Asks the Backend for the provider's page. Desktop binds the loopback first, since the page
    /// is made for its port, opens the page in the system browser and collects the session from
    /// the handoff it hears; web hands the page to the Frontend to open in the same tab.
    async fn sign_in(&self, attempt: Attempt, provider: Identity) {
        let Some(back) = platform::sign_in_return(self.0.origin.as_deref()).await else {
            return self.fail(
                attempt,
                "EveryMail could not listen for the sign-in. Try again",
            );
        };
        let (client, bound) = match back {
            Return::SameTab => (Client::Web(Web {}), None),
            Return::Loopback(bound, end) => {
                {
                    let state = self.lock();
                    if !state.live.waits_on(attempt) {
                        return;
                    }
                    *self.listening() = Some(end);
                }
                let port = bound.port().into();
                let loopback = NativeReturn::Loopback(Loopback { port });
                let native = Native {
                    r#return: Some(loopback),
                };
                (Client::Native(native), Some(bound))
            }
        };
        let request = StartSignInRequest {
            provider: Some(match provider {
                Identity::Google => Provider::Google(Google {}),
                Identity::Microsoft => Provider::Microsoft(Microsoft {}),
            }),
            client: Some(client),
        };
        let started = match self
            .auth::<StartSignInResponse>("StartSignIn", request)
            .await
        {
            Ok(started) => started,
            // The engine names only ports the Backend takes, so a bad request is a provider it
            // does not offer
            Err(Some(400)) => {
                let reason = format!("{} sign-in is not available", provider.name());
                return self.fail(attempt, &reason);
            }
            Err(_) => return self.fail(attempt, DID_NOT_START),
        };
        if !provider_page(&started.authorize_url, provider) {
            return self.fail(attempt, DID_NOT_START);
        }
        let Some(bound) = bound else {
            let open = SignInStep::Open(started.authorize_url);
            return self.answer(attempt, SignInAnswer::Step(open));
        };
        if !bound.open_page(&started.authorize_url) {
            return self.fail(attempt, "EveryMail could not open the browser. Try again");
        }
        self.answer(attempt, SignInAnswer::Step(SignInStep::Browser));
        let lifetime = Duration::from_secs(started.expires_in_seconds.into());
        let mut loopback = bound.listen(lifetime);
        loop {
            match loopback.wait().await {
                Wait::Candidate(handoff, listening) => {
                    let request = FinishSignInRequest {
                        claim: started.claim.clone(),
                        handoff: handoff.into_string(),
                    };
                    let outcome = self
                        .auth::<FinishSignInResponse>("FinishSignIn", request)
                        .await
                        .ok()
                        .and_then(|response| response.outcome);
                    match outcome {
                        // Not this attempt's handoff: something other than the Backend's page
                        // posted a guess, and the real one may still come
                        Some(Outcome::Pending(_)) => loopback = listening,
                        Some(Outcome::SignedIn(signed_in)) => {
                            return self.signed_in(attempt, provider, signed_in).await;
                        }
                        Some(Outcome::Denied(_)) => {
                            return self.fail(attempt, "Sign-in was cancelled");
                        }
                        Some(Outcome::Failed(_) | Outcome::Expired(_)) | None => {
                            return self.fail(attempt, DID_NOT_FINISH);
                        }
                    }
                }
                Wait::Ended => return,
                Wait::TimedOut => {
                    return self.fail(attempt, "The sign-in did not finish in time. Try again");
                }
                Wait::Failed => return self.fail(attempt, DID_NOT_FINISH),
            }
        }
    }

    /// Keeps a collected session and signs in, but only while its attempt is still waited on:
    /// otherwise, or when the keychain refuses it, the session is ended at the Backend and nothing
    /// is kept.
    async fn signed_in(&self, attempt: Attempt, provider: Identity, signed_in: SignedIn) {
        let SignedIn { bearer, email } = signed_in;
        if !platform::credential::save(&bearer) {
            self.end_session(Some(&bearer)).await;
            return self.fail(attempt, "EveryMail could not keep the session. Try again");
        }
        // Decided and applied under one lock, so a cancel lands wholly before or after
        let kept = {
            let state = self.lock();
            let waited = state.live.waits_on(attempt);
            if waited {
                self.hold(Some(bearer.clone()));
                *self.listening() = None;
                let update = Update::SignedIn {
                    user_name: email,
                    provider,
                };
                if self.dispatch_locked(state, Input::Update(update)).is_ok() {
                    self.request(Work::Sync);
                }
            }
            waited
        };
        if !kept {
            // The keychain goes back to the session in use, if there is one
            match self.credential().clone() {
                Some(held) => {
                    platform::credential::save(&held);
                }
                None => platform::credential::forget(),
            }
            self.end_session(Some(&bearer)).await;
        }
    }

    /// Ends the session `bearer` names, or the web app's cookie.
    async fn end_session(&self, bearer: Option<&str>) {
        // A session the Backend could not end expires there on its own.
        let _ = self
            .call::<SignOutResponse>("SignOut", SignOutRequest {}, bearer)
            .await;
    }

    /// The session the Backend holds for this device: the web app's cookie, or desktop's stored
    /// credential. Signed in, the first sync starts.
    async fn find_session(&self) {
        use get_session_response::Provider;
        let Ok(session) = self
            .auth::<GetSessionResponse>("GetSession", GetSessionRequest {})
            .await
        else {
            return;
        };
        let provider = match session.provider {
            Some(Provider::Google(_)) => Identity::Google,
            Some(Provider::Microsoft(_)) => Identity::Microsoft,
            None => return,
        };
        let signed_in = Update::SignedIn {
            user_name: session.email,
            provider,
        };
        if self.dispatch(Input::Update(signed_in)).is_ok() {
            self.request(Work::Sync);
        }
    }

    /// Ends the session at the Backend and forgets its credential. The replica dropped it already.
    async fn sign_out(&self) {
        let credential = self.credential().clone();
        self.end_session(credential.as_deref()).await;
        platform::credential::forget();
        self.hold(None);
    }
}

//! Sign-in and the session, with the Backend's `AuthService`. The web app returns from the
//! provider's page in the same tab and holds its session as a cookie; desktop hears the handoff on
//! a loopback port, collects a bearer token and keeps it in the keychain. Which one is the
//! platform's choice.

use prost::Message;

use crate::{
    Engine, Input,
    action::Auth,
    backend::{Request, Update, Work},
    live::{SignIn, SignInStep},
    platform::{self, Heard, Return},
    proto::api::v1::{
        FinishSignInRequest, FinishSignInResponse, GetSessionRequest, GetSessionResponse, Google,
        Loopback, Microsoft, Native, SignOutRequest, SignOutResponse, StartSignInRequest,
        StartSignInResponse, Web,
        finish_sign_in_response::Outcome,
        get_session_response,
        native::Return as NativeReturn,
        start_sign_in_request::{Client, Provider},
    },
    world::Identity,
};

const DID_NOT_FINISH: &str = "The sign-in did not finish. Try again";

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

    pub(crate) fn authenticate(&self, auth: Auth) {
        let engine = self.clone();
        (self.0.spawn)(Box::pin(async move {
            match auth {
                Auth::SignIn(provider) => engine.start_sign_in(provider).await,
                Auth::SignOut => engine.sign_out().await,
            }
        }));
    }

    fn hold(&self, credential: Option<String>) {
        *self
            .0
            .credential
            .lock()
            .expect("a credential holder panicked") = credential;
    }

    /// Calls an `AuthService` method with the session's credential: the answer of a 200, or
    /// `None`.
    async fn auth<A: Default + Message>(&self, method: &str, request: impl Message) -> Option<A> {
        let credential = self
            .0
            .credential
            .lock()
            .expect("a credential holder panicked")
            .clone();
        let body = platform::post(
            &format!("{}{method}", self.0.auth_url),
            request.encode_to_vec(),
            credential.as_deref(),
        )
        .await?;
        A::decode(body.as_slice()).ok()
    }

    fn fail(&self, reason: &str) {
        self.update(Update::Failed {
            request: Request::SignIn,
            reason: reason.into(),
        });
    }

    fn update(&self, update: Update) {
        // A failed read leaves the view as it was; the next input sends one.
        let _ = self.dispatch(Input::Update(update));
    }

    /// Asks the Backend for the provider's page, which the Frontend then opens. Desktop listens
    /// for the browser's return first, since the page is made for its port.
    async fn start_sign_in(&self, provider: Identity) {
        let Some(back) = platform::sign_in_return() else {
            return self.fail("EveryMail could not listen for the sign-in. Try again");
        };
        let client = match &back {
            Return::SameTab => Client::Web(Web {}),
            Return::Loopback(listener) => Client::Native(Native {
                r#return: Some(NativeReturn::Loopback(Loopback {
                    port: listener.port().into(),
                })),
            }),
        };
        let request = StartSignInRequest {
            provider: Some(match provider {
                Identity::Google => Provider::Google(Google {}),
                Identity::Microsoft => Provider::Microsoft(Microsoft {}),
            }),
            client: Some(client),
        };
        let Some(started) = self
            .auth::<StartSignInResponse>("StartSignIn", request)
            .await
        else {
            return self.fail("The sign-in could not start. Try again");
        };
        let open = SignIn::Waiting(provider, SignInStep::Open(started.authorize_url.clone()));
        self.update(Update::SignInOpen(started.authorize_url));
        let Return::Loopback(listener) = back else {
            return;
        };
        let (watching, finishing) = (self.clone(), self.clone());
        listener.serve(
            // A cancel, or a newer attempt, ends this one.
            move || watching.lock().live.sign_in == open,
            move |heard| match heard {
                Heard::Handoff(handoff) => {
                    let engine = finishing.clone();
                    (finishing.0.spawn)(Box::pin(async move {
                        engine.finish_sign_in(started.claim, handoff).await;
                    }));
                }
                Heard::Expired => finishing.fail("The sign-in did not finish in time. Try again"),
            },
        );
    }

    /// Collects the session the browser's handoff released, keeps its credential and signs in.
    async fn finish_sign_in(&self, claim: String, handoff: String) {
        let outcome = self
            .auth::<FinishSignInResponse>("FinishSignIn", FinishSignInRequest { claim, handoff })
            .await
            .and_then(|response| response.outcome);
        match outcome {
            Some(Outcome::SignedIn(signed_in)) => {
                if !platform::credential::save(&signed_in.bearer) {
                    return self.fail("EveryMail could not keep the session. Try again");
                }
                self.hold(Some(signed_in.bearer));
                self.find_session().await;
            }
            Some(Outcome::Denied(_)) => self.fail("Sign-in was cancelled"),
            // A pending answer cannot follow a handoff.
            Some(Outcome::Pending(_) | Outcome::Failed(_) | Outcome::Expired(_)) | None => {
                self.fail(DID_NOT_FINISH)
            }
        }
    }

    /// The session the Backend holds for this device: the web app's cookie, or desktop's stored
    /// credential. Signed in, the first sync starts.
    async fn find_session(&self) {
        use get_session_response::Provider;
        let Some(session) = self
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
        // A session the Backend could not end expires there on its own.
        let _ = self
            .auth::<SignOutResponse>("SignOut", SignOutRequest {})
            .await;
        platform::credential::forget();
        self.hold(None);
    }
}

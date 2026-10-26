//! SSH interactive-password handoff (spec §9.3).
//!
//! The password must reach `ssh` without ever appearing in argv, in an
//! environment *value*, on disk, in the ledger, or in a log. The mechanism:
//!
//! 1. The runtime holds the password only in memory, inside an
//!    [`SshSecretBroker`] bound to a loopback socket on an ephemeral port.
//! 2. A worker start in password mode gets three env entries added to the ssh
//!    child: `SSH_ASKPASS_REQUIRE=force`, `SSH_ASKPASS` (pointing at this
//!    binary), and `HAKUS_SSH_BROKER` — a one-time token plus broker address.
//!    The token is a capability, not the secret.
//! 3. `ssh` invokes the askpass helper, which connects to the broker, presents
//!    the token, and receives the password on its stdout pipe. The broker
//!    wipes the password once its fetch budget is spent.
//!
//! What this deliberately does not do: put the password in argv (ssh would
//! show it in process listings), in an env *value* (children inherit and some
//! tools dump env), or in a file (temp files outlive their writers on
//! Windows).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How many askpass fetches one provisioned password allows. ssh may call the
/// helper more than once (a retried prompt, multiple keyboard-interactive
/// rounds), but an unbounded budget would let a stray loopback reader keep
/// pulling the secret.
const MAX_FETCHES: usize = 4;

/// How long a provisioned broker stays reachable. Long enough for a worker
/// start; short enough that a forgotten provision does not linger all day.
const BROKER_WINDOW: Duration = Duration::from_secs(120);

/// Environment marker telling this binary, when executed by ssh, to act as the
/// askpass helper instead of starting the TUI/runtime. ssh launches
/// `SSH_ASKPASS` with no arguments, so the marker has to be environmental.
pub const ASKPASS_MARKER_ENV: &str = "HAKUS_SSH_ASKPASS";
/// Capability the askpass helper presents: `<token>@<address>`.
pub const BROKER_ENV: &str = "HAKUS_SSH_BROKER";

/// An in-memory, loopback-only broker for one SSH password.
pub struct SshSecretBroker {
    address: SocketAddr,
    token: String,
    remaining: AtomicUsize,
    wipe_requested: AtomicBool,
    /// `None` once wiped or shut down. The `String` bytes are zeroed on wipe.
    password: Mutex<Option<Vec<u8>>>,
    /// Owned by the serve thread; `take()`ing it from Drop wakes the loop.
    listener: Mutex<Option<TcpListener>>,
}

impl SshSecretBroker {
    /// Bind a broker on an ephemeral loopback port and start serving. Fails if
    /// no loopback listener can be bound, which is a hard environment failure —
    /// password mode cannot degrade into a weaker channel.
    pub fn provision(password: &str) -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let broker = Arc::new(Self {
            address,
            token: new_token(),
            remaining: AtomicUsize::new(MAX_FETCHES),
            wipe_requested: AtomicBool::new(false),
            password: Mutex::new(Some(password.as_bytes().to_vec())),
            listener: Mutex::new(Some(listener)),
        });
        let server = Arc::clone(&broker);
        std::thread::spawn(move || server.serve_loop());
        Ok(broker)
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The env value the askpass helper needs. It names the door; it is not
    /// the secret, and it dies with the broker.
    pub fn broker_env(&self) -> String {
        format!("{}@{}", self.token, self.address)
    }

    pub fn exhausted(&self) -> bool {
        self.remaining.load(Ordering::SeqCst) == 0
    }

    fn serve_loop(self: Arc<Self>) {
        let deadline = Instant::now() + BROKER_WINDOW;
        loop {
            if self.exhausted() || Instant::now() >= deadline {
                self.wipe();
                return;
            }
            // take() from Drop removes the listener; that is the shutdown
            // signal, so an absent listener ends the thread.
            let Some(listener) = self
                .listener
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().and_then(|l| l.try_clone().ok()))
            else {
                return;
            };
            listener.set_nonblocking(true).ok();
            match listener.accept() {
                Ok((stream, _peer)) => self.serve_once(stream),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if self.wipe_requested.load(Ordering::SeqCst) {
                        self.wipe();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => {
                    self.wipe();
                    return;
                }
            }
        }
    }

    fn serve_once(&self, mut stream: TcpStream) {
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut request = String::new();
        match stream.try_clone() {
            Ok(reader) => {
                if BufReader::new(reader).read_line(&mut request).is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
        let authorized = request.strip_prefix("GET ").is_some_and(|presented| {
            presented.trim() == self.token && !self.exhausted()
        });
        let response = if authorized {
            match self.password.lock().ok().and_then(|mut g| g.clone()) {
                Some(password) => {
                    self.remaining.fetch_sub(1, Ordering::SeqCst);
                    if self.exhausted() {
                        self.wipe_requested.store(true, Ordering::SeqCst);
                    }
                    let mut line = b"OK ".to_vec();
                    line.extend_from_slice(&password);
                    line.push(b'\n');
                    line
                }
                None => b"ERR gone\n".to_vec(),
            }
        } else {
            b"ERR denied\n".to_vec()
        };
        stream.write_all(&response).ok();
        stream.flush().ok();
    }

    /// Drop the stored password, zeroing its bytes, and close the listener.
    fn wipe(&self) {
        if let Ok(mut guard) = self.password.lock() {
            if let Some(password) = guard.take() {
                let mut bytes = password;
                for byte in bytes.iter_mut() {
                    *byte = 0;
                }
                drop(bytes);
            }
        }
        if let Ok(mut guard) = self.listener.lock() {
            *guard = None;
        }
    }
}

impl std::fmt::Debug for SshSecretBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately does not derive Debug: a derive would print the stored
        // password into any log or error message that touched the adapter.
        f.debug_struct("SshSecretBroker")
            .field("address", &self.address)
            .field("exhausted", &self.exhausted())
            .finish_non_exhaustive()
    }
}

impl Drop for SshSecretBroker {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// Fetch the password from a broker. This is the askpass-helper side of the
/// protocol: connect, present the token, read one line.
pub fn fetch(broker: &str) -> Result<String, String> {
    let (token, address) = broker
        .rsplit_once('@')
        .ok_or_else(|| "malformed broker address".to_string())?;
    let mut stream = TcpStream::connect(address)
        .map_err(|err| format!("broker unreachable: {err}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream
        .write_all(format!("GET {token}\n").as_bytes())
        .map_err(|err| format!("broker write failed: {err}"))?;
    // One line, not read_to_end: the server keeps the connection open after
    // answering (it does not know whether it will serve another fetch), so an
    // EOF wait would burn the read timeout and deliver an empty password.
    let mut response = String::new();
    BufReader::new(&mut stream)
        .read_line(&mut response)
        .map_err(|err| format!("broker read failed: {err}"))?;
    match response.strip_prefix("OK ") {
        Some(password) => Ok(password.trim_end_matches(['\n', '\r']).to_string()),
        None => Err("broker refused the request".to_string()),
    }
}

/// Entry point for the askpass helper mode. Returns the process exit code.
/// ssh reads the password from the helper's stdout — nothing else may ever be
/// printed on that pipe.
pub fn run_askpass() -> i32 {
    let Some(broker) = std::env::var(BROKER_ENV).ok().filter(|v| !v.is_empty()) else {
        return 1;
    };
    match fetch(&broker) {
        Ok(password) => {
            println!("{password}");
            0
        }
        Err(_) => 1,
    }
}

fn new_token() -> String {
    // getrandom-backed v4 UUID: 122 CSPRNG bits, unguessable and unusable once
    // the broker wipes.
    uuid::Uuid::new_v4().simple().to_string()
}

/// In-memory vault for SSH passwords keyed by host identity. The runtime API
/// provisions it (from a secure user-input boundary); a worker start consumes
/// the entry, and the broker wipes itself after its fetch budget is spent.
#[derive(Default)]
pub struct SshPasswordVault {
    entries: Mutex<HashMap<String, Arc<SshSecretBroker>>>,
}

impl SshPasswordVault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Provision a fresh broker for `key` (e.g. `user@host:port`), replacing
    /// any previous one. The old broker keeps serving only until its own
    /// budget/window ends; it is no longer reachable through the vault.
    pub fn provision(&self, key: &str, password: &str) -> std::io::Result<Arc<SshSecretBroker>> {
        let broker = SshSecretBroker::provision(password)?;
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key.to_string(), Arc::clone(&broker));
        }
        Ok(broker)
    }

    /// Take the broker for `key`, removing it from the vault. The caller
    /// attaches it to exactly one worker start; the broker wipes itself after
    /// its fetch budget.
    pub fn take(&self, key: &str) -> Option<Arc<SshSecretBroker>> {
        self.entries
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(key))
    }

    /// Report whether a one-shot broker is still waiting to be consumed.
    ///
    /// This intentionally exposes only presence, never the broker or its
    /// secret. Runtime diagnostics do not call this; the narrow crate-visible
    /// seam exists for lifecycle tests that need to distinguish provisioning
    /// from worker consumption.
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.entries
            .lock()
            .ok()
            .is_some_and(|entries| entries.contains_key(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provisioned_broker_serves_the_password_to_the_right_token() {
        let broker = SshSecretBroker::provision("hunter2").unwrap();
        let fetched = fetch(&broker.broker_env()).expect("the token must unlock the password");
        assert_eq!(fetched, "hunter2");
    }

    #[test]
    fn a_wrong_token_is_denied() {
        let broker = SshSecretBroker::provision("hunter2").unwrap();
        let forged = format!("00000000000000000000000000000000@{}", broker.address());
        let error = fetch(&forged).expect_err("a forged token must be denied");
        assert!(error.contains("refused"), "{error}");
    }

    #[test]
    fn the_budget_is_bounded_and_then_the_secret_is_gone() {
        let broker = SshSecretBroker::provision("hunter2").unwrap();
        for _ in 0..MAX_FETCHES {
            fetch(&broker.broker_env()).unwrap();
        }
        assert!(broker.exhausted());
        // The refusal surface races the serve loop's shutdown: the fetch may
        // be denied in-band ("gone"/"refused") or hit a closed listener. The
        // property under test is only that no password is delivered.
        let error = fetch(&broker.broker_env()).expect_err("an exhausted broker must not deliver");
        assert!(!error.is_empty(), "{error}");
    }

    #[test]
    fn wiping_leaves_no_password_to_serve() {
        let broker = SshSecretBroker::provision("hunter2").unwrap();
        broker.wipe();
        assert!(broker.password.lock().unwrap().is_none());
        let error = fetch(&broker.broker_env()).expect_err("a wiped broker must refuse");
        assert!(!error.is_empty(), "{error}");
    }

    #[test]
    fn the_vault_hands_out_the_broker_exactly_once() {
        let vault = SshPasswordVault::new();
        vault.provision("fleet@host:22", "hunter2").unwrap();
        assert!(vault.take("fleet@host:22").is_some());
        assert!(
            vault.take("fleet@host:22").is_none(),
            "a second take must not re-arm the same password"
        );
    }

    #[test]
    fn reprovisioning_detaches_the_previous_broker() {
        let vault = SshPasswordVault::new();
        let first = vault.provision("fleet@host:22", "old").unwrap();
        let second = vault.provision("fleet@host:22", "new").unwrap();
        assert_eq!(
            fetch(&second.broker_env()).unwrap(),
            "new",
            "the replacement broker serves the new password"
        );
        assert_eq!(
            fetch(&first.broker_env()).unwrap(),
            "old",
            "the detached broker still serves its own budget; the vault replacement concerns future starts"
        );
    }
}

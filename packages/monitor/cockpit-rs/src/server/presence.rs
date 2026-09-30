#![allow(dead_code)] // Callers are the inbox, permission and views routes.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Default)]
pub struct Presence {
    seen: Mutex<HashMap<String, Instant>>,
    parked: Mutex<HashSet<String>>,
    subscribers: Mutex<HashMap<String, Vec<UnboundedSender<String>>>>,
}

impl Presence {
    pub fn mark_channel_seen(&self, session: &str) {
        self.seen
            .lock()
            .expect("presence lock poisoned")
            .insert(session.into(), Instant::now());
    }

    pub fn set_channel_parked(&self, session: &str, parked: bool) {
        let mut sessions = self.parked.lock().expect("presence lock poisoned");
        if parked {
            sessions.insert(session.into());
        } else {
            sessions.remove(session);
        }
    }

    pub fn has_channel(&self, session: &str) -> bool {
        if self
            .parked
            .lock()
            .expect("presence lock poisoned")
            .contains(session)
        {
            return true;
        }
        let ttl = Duration::from_millis(crate::tunables::env_int("COCKPIT_CHANNEL_TTL_MS", 5_000));
        self.seen
            .lock()
            .expect("presence lock poisoned")
            .get(session)
            .is_some_and(|seen| seen.elapsed() < ttl)
    }

    pub fn add_subscriber(&self, session: &str, tx: UnboundedSender<String>) {
        self.subscribers
            .lock()
            .expect("presence lock poisoned")
            .entry(session.into())
            .or_default()
            .push(tx);
    }

    pub fn broadcast(&self, session: &str, chunk: &str) {
        let mut subscribers = self.subscribers.lock().expect("presence lock poisoned");
        if let Some(senders) = subscribers.get_mut(session) {
            senders.retain(|tx| tx.send(chunk.to_owned()).is_ok());
            if senders.is_empty() {
                subscribers.remove(session);
            }
        }
    }

    pub fn has_visible_subscriber(&self, session: &str) -> bool {
        let mut subscribers = self.subscribers.lock().expect("presence lock poisoned");
        if let Some(senders) = subscribers.get_mut(session) {
            senders.retain(|tx| !tx.is_closed());
            if !senders.is_empty() {
                return true;
            }
            subscribers.remove(session);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn channel_ttl_and_parked_presence() {
        let _env = TestEnv::new();
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                // TestEnv serializes environment mutation but does not track this server-only variable.
                unsafe {
                    if let Some(value) = &self.0 {
                        std::env::set_var("COCKPIT_CHANNEL_TTL_MS", value);
                    } else {
                        std::env::remove_var("COCKPIT_CHANNEL_TTL_MS");
                    }
                }
            }
        }
        let _restore = Restore(std::env::var_os("COCKPIT_CHANNEL_TTL_MS"));
        TestEnv::set("COCKPIT_CHANNEL_TTL_MS", "100");
        let presence = Presence::default();
        assert!(!presence.has_channel("session"));
        presence.mark_channel_seen("session");
        assert!(presence.has_channel("session"));
        presence.seen.lock().unwrap().insert(
            "session".into(),
            Instant::now() - Duration::from_millis(200),
        );
        assert!(!presence.has_channel("session"));
        presence.set_channel_parked("session", true);
        assert!(presence.has_channel("session"));
        presence.set_channel_parked("session", false);
        assert!(!presence.has_channel("session"));
        TestEnv::set("COCKPIT_CHANNEL_TTL_MS", "invalid");
        assert!(presence.has_channel("session"));
    }

    #[test]
    fn probe_and_broadcast_prune_closed_subscribers() {
        let presence = Presence::default();
        let (closed, receiver) = unbounded_channel();
        presence.add_subscriber("session", closed);
        drop(receiver);
        assert!(!presence.has_visible_subscriber("session"));
        assert!(presence.subscribers.lock().unwrap().is_empty());
        let (first, mut receiver) = unbounded_channel();
        let (second, closed_receiver) = unbounded_channel();
        presence.add_subscriber("session", first);
        presence.add_subscriber("session", second);
        drop(closed_receiver);
        assert!(presence.has_visible_subscriber("session"));
        presence.broadcast("session", "chunk");
        assert_eq!(receiver.try_recv().unwrap(), "chunk");
        drop(receiver);
        presence.broadcast("session", "next");
        assert!(presence.subscribers.lock().unwrap().is_empty());
    }
}

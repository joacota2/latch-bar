//! One lock arbitrates starting work, editing profiles, and replacing the app.
use std::sync::{Arc, Mutex};

pub const UPDATING: &str = "Latch Bar is updating. Please wait for it to restart.";

#[derive(Default)]
struct State {
    runs: usize,
    installing: bool,
    editor_open: bool,
}

#[derive(Clone, Default)]
pub struct ActivityGate(Arc<Mutex<State>>);

pub struct RunPermit(ActivityGate);
pub struct InstallPermit(ActivityGate);

impl ActivityGate {
    pub fn start_run(&self) -> Result<RunPermit, String> {
        let mut state = self.0.lock().map_err(|_| "Activity state unavailable")?;
        if state.installing {
            return Err(UPDATING.into());
        }
        state.runs += 1;
        Ok(RunPermit(self.clone()))
    }

    pub fn install(&self) -> Result<InstallPermit, String> {
        let mut state = self.0.lock().map_err(|_| "Activity state unavailable")?;
        if state.installing {
            return Err(UPDATING.into());
        }
        if state.editor_open {
            return Err("Save your changes and close the agent editor before updating.".into());
        }
        if state.runs > 0 {
            return Err(
                "Finish or cancel active agents, including pending approvals, before updating."
                    .into(),
            );
        }
        state.installing = true;
        Ok(InstallPermit(self.clone()))
    }

    pub fn set_editor_open(&self, open: bool) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "Activity state unavailable")?;
        if open && state.installing {
            return Err(UPDATING.into());
        }
        state.editor_open = open;
        Ok(())
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.runs -= 1;
        }
    }
}

impl Drop for InstallPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.installing = false;
        }
    }
}

/// Owned by a runtime process, shared with its stdout reader and timeout handler.
/// An idle process keeps this slot empty, so it does not block installation.
#[derive(Clone)]
pub struct RunActivity(Arc<Mutex<Option<RunPermit>>>);

impl RunActivity {
    pub fn new(permit: RunPermit) -> Self {
        Self(Arc::new(Mutex::new(Some(permit))))
    }

    pub fn resume(&self, gate: &ActivityGate) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "Activity state unavailable")?;
        if slot.is_some() {
            return Err("This agent already has an active turn.".into());
        }
        *slot = Some(gate.start_run()?);
        Ok(())
    }

    pub fn finish(&self) {
        if let Ok(mut slot) = self.0.lock() {
            slot.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_running_and_waiting_for_approval_block_installation() {
        let gate = ActivityGate::default();
        let run = RunActivity::new(gate.start_run().unwrap());
        assert!(gate.install().is_err());
        // Approval and interrupt requests do not release the activity lease.
        assert!(gate.install().is_err());
        run.finish();
        assert!(gate.install().is_ok());
    }

    #[test]
    fn installation_blocks_new_work_and_continuations_until_released() {
        let gate = ActivityGate::default();
        let run = RunActivity::new(gate.start_run().unwrap());
        run.finish();
        let install = gate.install().unwrap();
        assert!(gate.start_run().is_err());
        assert!(run.resume(&gate).is_err());
        assert!(gate.install().is_err());
        assert!(gate.set_editor_open(true).is_err());
        drop(install); // Includes download and installation failure paths.
        run.resume(&gate).unwrap();
        assert!(gate.install().is_err());
        run.finish();
        run.finish(); // EOF after completion must be harmless.
        assert!(gate.install().is_ok());
    }

    #[test]
    fn early_failure_and_editor_close_release_the_gate() {
        let gate = ActivityGate::default();
        drop(gate.start_run().unwrap());
        gate.set_editor_open(true).unwrap();
        assert!(gate.install().is_err());
        gate.set_editor_open(false).unwrap();
        assert!(gate.install().is_ok());
    }

    #[test]
    fn concurrent_start_and_install_cannot_both_acquire_a_lease() {
        use std::{sync::Barrier, thread};
        for _ in 0..50 {
            let gate = ActivityGate::default();
            let barrier = Arc::new(Barrier::new(2));
            let worker_gate = gate.clone();
            let worker_barrier = barrier.clone();
            let worker = thread::spawn(move || {
                worker_barrier.wait();
                let permit = worker_gate.start_run();
                worker_barrier.wait(); // Keep the winner's lease until both tried.
                permit.is_ok()
            });
            barrier.wait();
            let install = gate.install();
            barrier.wait();
            let started = worker.join().unwrap();
            assert_ne!(install.is_ok(), started);
        }
    }
}

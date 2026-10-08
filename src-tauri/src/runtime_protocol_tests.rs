use super::*;
use std::{sync::mpsc, time::{Duration, Instant}};
fn fixture(scenario: &str) -> (RuntimeManager, RuntimeEvents, mpsc::Receiver<Value>, String) {
    let manager = RuntimeManager::default();
    let (sender, receiver) = mpsc::channel();
    let events = RuntimeEvents::new(move |name, value| { if name == "codex-event" { let _ = sender.send(value); } Ok(()) });
    let agent = AgentRuntimeConfig {
        model: None, reasoning_effort: None, service_tier: None, sandbox: "read-only".into(), permission_profile: None,
        approval_policy: "when-needed".into(), codex_profile: None, workspace_mode: "fixed".into(),
        fixed_workspace_path: Some(std::env::temp_dir().to_string_lossy().into_owned()), enabled_mcp_servers: vec![], enabled_skills: vec![], resolved_skills: vec![],
    };
    let factory = |_: Option<&str>| { let mut command = Command::new("python3"); command.arg("-u").arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/app_server.py")).arg(scenario); Ok(command) };
    let permit = manager.1.start_run().unwrap();
    let run = start_codex_run_blocking(events.clone(), manager.clone(), agent, "Test prompt".into(), "Task: Test".into(), (permit, 0), Driver { command: &factory, turn_start_timeout: Duration::from_millis(250) }).unwrap();
    (manager, events, receiver, run.run_id)
}
fn until(receiver: &mpsc::Receiver<Value>, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop { let event = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("Missing protocol event"); if predicate(&event["message"]) { return event["message"].clone(); } }
}
#[test]
fn real_transport_streams_and_survives_malformed_lines() {
    for scenario in ["normal", "malformed"] {
        let (manager, _, receiver, _) = fixture(scenario);
        let delta = until(&receiver, |message| message["method"] == "item/agentMessage/delta");
        assert_eq!(delta["params"]["delta"], "Hello 😀");
        until(&receiver, |message| message["method"] == "turn/completed");
        manager.shutdown();
        until(&receiver, |message| message["method"] == "runtime/exited");
    }
}
#[test]
fn approval_registry_uses_typed_ids_and_rejects_duplicate_and_wrong_run_responses() {
    let (manager, _, receiver, run) = fixture("approvals");
    until(&receiver, |message| message["id"] == 7 && message["method"] == "item/commandExecution/requestApproval");
    until(&receiver, |message| message["id"] == "7");
    let allow = json!({"decision":"accept"});
    assert!(answer_approval(&manager, "another-run", &json!(7), &allow).is_err());
    answer_approval(&manager, &run, &json!(7), &allow).unwrap();
    assert!(answer_approval(&manager, &run, &json!(7), &allow).is_err());
    answer_approval(&manager, &run, &json!("7"), &allow).unwrap();
    until(&receiver, |message| message["method"] == "turn/completed");
    manager.shutdown();
    assert!(answer_approval(&manager, &run, &json!("7"), &allow).is_err());
}
#[test]
fn eof_stalls_continuations_and_shutdown_release_processes() {
    let (manager, _, receiver, _) = fixture("eof");
    until(&receiver, |message| message["method"] == "runtime/exited"); manager.shutdown();
    let (manager, _, receiver, _) = fixture("stall");
    until(&receiver, |message| message.get("error").is_some());
    until(&receiver, |message| message["method"] == "runtime/exited"); manager.shutdown();
    let (manager, events, receiver, run) = fixture("continuation-stall");
    until(&receiver, |message| message["method"] == "turn/completed");
    continue_run(events, &manager, run, "Again".into(), Duration::from_millis(70)).unwrap();
    until(&receiver, |message| message.get("error").is_some());
    until(&receiver, |message| message["method"] == "runtime/exited"); manager.shutdown();
    let (manager, _, receiver, _) = fixture("active");
    until(&receiver, |message| message["method"] == "turn/started"); manager.shutdown();
    until(&receiver, |message| message["method"] == "runtime/exited");
}

#[test]
fn user_approval_suspends_startup_deadline_and_late_responses_cannot_end_a_follow_up() {
    let (manager, _, receiver, run) = fixture("startup-approval");
    until(&receiver, |message| message["method"] == "item/commandExecution/requestApproval");
    std::thread::sleep(Duration::from_millis(320));
    assert!(receiver.try_recv().is_err());
    answer_approval(&manager, &run, &json!(7), &json!({"decision":"accept"})).unwrap();
    until(&receiver, |message| message["method"] == "turn/completed"); manager.shutdown();
    let (manager, events, receiver, run) = fixture("late");
    until(&receiver, |message| message["method"] == "turn/completed");
    continue_run(events, &manager, run, "Again".into(), Duration::from_millis(250)).unwrap();
    let next = until(&receiver, |message| {
        assert!(message.get("error").is_none());
        if message["method"] == "turn/completed" { assert_eq!(message["params"]["turn"]["id"], "turn-2"); true } else { false }
    });
    assert_eq!(next["params"]["turn"]["status"], "completed"); manager.shutdown();
}

#[test]
fn cancellation_reaches_the_subprocess_and_shutdown_reaps_it() {
    let (manager, _, receiver, run) = fixture("active");
    until(&receiver, |message| message["method"] == "turn/started");
    interrupt_run(&manager, &run).unwrap();
    let completed = until(&receiver, |message| message["method"] == "turn/completed");
    assert_eq!(completed["params"]["turn"]["status"], "interrupted");
    let child = manager.0.lock().unwrap().get(&run).unwrap().child.clone();
    manager.shutdown(); assert!(child.lock().unwrap().try_wait().unwrap().is_some());
}

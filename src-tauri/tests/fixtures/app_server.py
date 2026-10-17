"""Offline protocol peer. Used by Rust tests through real pipes, never Codex."""
import json
import sys

scenario = sys.argv[1]
responses = 0
turns = 0

def emit(value):
    print(json.dumps(value), flush=True)

def complete():
    emit({"method": "item/agentMessage/delta", "params": {"delta": "Hello 😀", "threadId": "main"}})
    emit({"method": "turn/completed", "params": {"threadId": "main", "turn": {"id": f"turn-{turns}", "status": "completed", "items": [{"type": "agentMessage", "text": "Hello 😀"}]}}})

if scenario == "eof":
    sys.exit(0)
for line in sys.stdin:
    message = json.loads(line)
    method, request = message.get("method"), message.get("id")
    if scenario == "stall":
        continue
    if method == "initialize":
        if scenario == "malformed":
            print("not JSON", flush=True)
        emit({"id": request, "result": {}})
    elif method == "config/read":
        emit({"id": request, "result": {"config": {"mcp_servers": {}}}})
    elif method == "thread/start":
        if isinstance(request, str):
            emit({"id": request, "error": {"message": "Title unavailable in fixture"}})
        else:
            emit({"id": request, "result": {"thread": {"id": "main"}}})
    elif method == "turn/start":
        turns += 1
        if scenario == "continuation-stall" and turns > 1:
            continue
        if scenario == "late" and turns > 1:
            emit({"id": 2, "error": {"message": "Stale previous response"}})
            emit({"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}})
        if scenario == "startup-approval":
            emit({"id": 7, "method": "item/commandExecution/requestApproval", "params": {"command": "echo safe"}})
            continue
        emit({"id": request, "result": {"turn": {"id": f"turn-{turns}"}}})
        emit({"method": "turn/started", "params": {"threadId": "main", "turn": {"id": f"turn-{turns}"}}})
        if scenario == "approvals":
            for ident in [7, "7", 7]:
                emit({"id": ident, "method": "item/commandExecution/requestApproval", "params": {"threadId": "main", "command": "echo safe", "cwd": "/tmp"}})
        elif scenario != "active":
            complete()
    elif method == "turn/interrupt":
        emit({"method": "turn/completed", "params": {"turn": {"status": "interrupted"}}})
    elif "result" in message:
        responses += 1
        if scenario == "startup-approval":
            emit({"method": "turn/started", "params": {"turn": {"id": f"turn-{turns}"}}})
            complete()
        elif responses == 2:
            complete()

//! Only responses to live requests belonging to this process may reach Codex.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Default)]
pub(crate) struct PendingApprovals(HashMap<String, Value>, HashSet<String>);
fn key(id: &Value) -> Result<String, String> {
    if id.is_string() || id.is_i64() || id.is_u64() {
        Ok(id.to_string())
    } else {
        Err("Invalid approval request ID".into())
    }
}
pub(crate) fn is_approval(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}
fn known_permissions(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "network" => {
            value.is_null()
                || value.as_object().is_some_and(|map| {
                    map.contains_key("enabled")
                        && map.iter().all(|(key, value)| {
                            key == "enabled" && (value.is_boolean() || value.is_null())
                        })
                })
        }
        "fileSystem" => {
            value.is_null()
                || value.as_object().is_some_and(|map| {
                    map.iter().all(|(key, value)| {
                        matches!(key.as_str(), "read" | "write")
                            && (value.is_null()
                                || value
                                    .as_array()
                                    .is_some_and(|paths| paths.iter().all(Value::is_string)))
                    })
                })
        }
        _ => false,
    })
}
impl PendingApprovals {
    pub fn insert(&mut self, message: &Value) {
        if message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(is_approval)
        {
            if let Some(id) = message.get("id").and_then(|id| key(id).ok()) {
                if self.1.insert(id.clone()) {
                    self.0.insert(id, message.clone());
                }
            }
        }
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn validate(&self, id: &Value, response: &Value) -> Result<(), String> {
        let request = self
            .0
            .get(&key(id)?)
            .ok_or("This approval is no longer pending")?;
        let valid = if request["method"] == "item/permissions/requestApproval" {
            let requested = &request["params"]["permissions"];
            let expected = requested.as_object().map(|map| {
                Value::Object(
                    map.iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                )
            });
            response == &json!({"permissions": {}, "scope": "turn"})
                || (known_permissions(requested)
                    && expected.is_some_and(|permissions| {
                        response == &json!({"permissions": permissions, "scope":"turn"})
                    }))
        } else {
            response == &json!({"decision":"accept"}) || response == &json!({"decision":"decline"})
        };
        if valid {
            Ok(())
        } else {
            Err("Unsupported approval response or permission scope".into())
        }
    }
    pub fn remove(&mut self, id: &Value) {
        if let Ok(id) = key(id) {
            self.0.remove(&id);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_and_responses_are_scoped_and_consumed_individually() {
        let mut queue = PendingApprovals::default();
        for id in [json!(1), json!("1")] {
            queue.insert(&json!({"id":id,"method":"item/commandExecution/requestApproval"}));
        }
        let response = json!({"decision":"accept"});
        assert!(queue.validate(&json!(2), &response).is_err());
        assert!(queue.validate(&json!(1), &response).is_ok());
        queue.remove(&json!(1));
        assert!(queue.validate(&json!(1), &response).is_err());
        assert!(queue.validate(&json!("1"), &response).is_ok());
        queue.clear();
        assert!(queue.validate(&json!("1"), &response).is_err());
    }
    #[test]
    fn cannot_broaden_permissions_or_approve_unknown_shapes() {
        let mut queue = PendingApprovals::default();
        let permissions = json!({"fileSystem":{"write":["/tmp/test"]}});
        queue.insert(&json!({"id":1,"method":"item/permissions/requestApproval","params":{"permissions":permissions}}));
        assert!(queue
            .validate(
                &json!(1),
                &json!({"permissions":permissions,"scope":"turn"})
            )
            .is_ok());
        assert!(queue
            .validate(
                &json!(1),
                &json!({"permissions":permissions,"scope":"session"})
            )
            .is_err());
        queue.insert(&json!({"id":2,"method":"item/permissions/requestApproval","params":{"permissions":{"futureAccess":true}}}));
        assert!(queue
            .validate(
                &json!(2),
                &json!({"permissions":{"futureAccess":true},"scope":"turn"})
            )
            .is_err());
        assert!(queue
            .validate(&json!(2), &json!({"permissions":{},"scope":"turn"}))
            .is_ok());
    }
}

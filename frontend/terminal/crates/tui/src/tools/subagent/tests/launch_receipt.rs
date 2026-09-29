//! Hermetic #5305 route-receipt regressions kept out of the oversized parent
//! sub-agent test module.

use super::*;

fn personal_consultant_runtime(
    workspace: &std::path::Path,
    manager: SharedSubAgentManager,
) -> SubAgentRuntime {
    let config = crate::config::Config {
        api_key: Some("deepseek-test-key".to_string()),
        provider: Some("deepseek".to_string()),
        ..Default::default()
    };
    let client = DeepSeekClient::new(&config).expect("DeepSeek parent client");
    SubAgentRuntime::new(
        client,
        "deepseek-v4-flash".to_string(),
        ToolContext::new(workspace.to_path_buf()),
        false,
        None,
        manager,
    )
    .with_api_config(config)
}



async fn start_personal_consultant(
    workspace: &std::path::Path,
) -> (
    SharedSubAgentManager,
    ToolContext,
    crate::tools::spec::ToolResult,
) {
    let manager = new_shared_subagent_manager(workspace.to_path_buf(), 4);
    let context = ToolContext::new(workspace.to_path_buf());
    let tool = AgentTool::new(
        manager.clone(),
        personal_consultant_runtime(workspace, manager.clone()),
    );
    let result = tool
        .execute(
            json!({
                "action": "start",
                "type": "consultant",
                "prompt": "inspect the request without writing files",
            }),
            &context,
        )
        .await
        .expect("profile-pinned consultant starts");
    (manager, context, result)
}

fn receipt_from(result: &crate::tools::spec::ToolResult) -> serde_json::Value {
    let content: serde_json::Value =
        serde_json::from_str(&result.content).expect("start result is JSON");
    let metadata = result.metadata.as_ref().expect("ToolResult metadata");
    assert_eq!(content["child_route"], metadata["child_route"]);
    content["child_route"].clone()
}

async fn cancel_started(manager: &SharedSubAgentManager, result: &crate::tools::spec::ToolResult) {
    let agent_id = result
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("agent_id"))
        .and_then(serde_json::Value::as_str)
        .expect("start agent id")
        .to_string();
    manager
        .write()
        .await
        .cancel_agent(&agent_id)
        .expect("cancel test child");
}




#[tokio::test]
async fn issue_5305_unbuildable_route_refuses_before_worktree_admission() {
    let _env_lock = crate::test_support::lock_test_env();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = crate::test_support::EnvVarGuard::set("HAKUS_HOME", home.path());
    let agents = home.path().join("agents");
    std::fs::create_dir_all(&agents).expect("agents");
    std::fs::write(
        agents.join("consultant.toml"),
        "id = \"consultant\"\nrole_hint = \"consultant\"\nprovider = \"deepseek\"\nmodel = \"not-a-deepseek-model\"\n",
    )
    .expect("bad profile");
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let manager = new_shared_subagent_manager(workspace.path().to_path_buf(), 1);
    let context = ToolContext::new(workspace.path().to_path_buf());
    let tool = AgentTool::new(
        manager.clone(),
        personal_consultant_runtime(workspace.path(), manager.clone()),
    );
    let worktree = workspace.path().join("must-not-exist");
    let err = tool
        .execute(
            json!({
                "action":"start", "type":"consultant", "prompt":"refuse before admission",
                "worktree": true, "cwd": worktree,
            }),
            &context,
        )
        .await
        .expect_err("unbuildable model refuses before admission");
    assert!(err.to_string().contains("model"), "{err}");
    assert!(manager.read().await.list_filtered(true).is_empty());
    assert!(!worktree.exists());
}


#[test]
fn issue_5305_builtin_inheritance_and_redaction_are_bounded() {
    let request =
        parse_spawn_request(&json!({"prompt":"x", "type":"consultant"})).expect("request");
    let mut runtime = stub_runtime();
    runtime.model = "deepseek-v4-flash".to_string();
    let member = runtime
        .fleet_roster
        .get("consultant")
        .expect("built-in member");
    let requested_route = RequestedChildRoute {
        requested_type: "consultant".to_string(),
        requested_profile: None,
        requested_reasoning: "inherit".to_string(),
    };
    let receipt = mint_child_route_receipt(
        &requested_route,
        &request,
        Some(member),
        &runtime,
        "deepseek-v4-flash".to_string(),
        "run.model",
    )
    .expect("bounded receipt");
    let encoded = serde_json::to_string(&receipt).expect("receipt json");
    assert!(encoded.len() <= CHILD_ROUTE_RECEIPT_MAX_BYTES);
    assert_eq!(receipt.profile_origin.as_deref(), Some("built-in"));
    assert_eq!(receipt.route_source, "run.model");
    for forbidden in ["test-key", "127.0.0.1", "hakus-test-stub", "/"] {
        assert!(
            !encoded.contains(forbidden),
            "receipt leaked {forbidden}: {encoded}"
        );
    }
}

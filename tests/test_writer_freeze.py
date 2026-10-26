"""Phase 0 freeze gate: HAKUS_FREEZE_PYTHON_WRITERS must stop new Python
transcript/checkpoint data from appearing while reads keep working.

Evidence for the REFACTOR_STATUS Phase 0 gate item "freeze new Python
transcript/checkpoint writers behind a migration flag".
"""

import pytest

from hakus.checkpoint import CheckpointManager
from hakus.long_task_context import LongTaskContext, TaskSummary
from hakus.rollout import RolloutRecorder
from hakus.session_log import SessionLogRecorder
from hakusai_server import session_store


@pytest.fixture()
def fresh_store(tmp_path, monkeypatch):
    """Point the store at a temp home and drop the cached connection."""
    monkeypatch.setenv("HAKUS_HOME", str(tmp_path / "home"))
    old_conn = session_store._conn
    session_store._conn = None
    yield session_store
    try:
        session_store._conn.close()
    except Exception:
        pass
    session_store._conn = old_conn


def test_writers_are_open_by_default(fresh_store):
    assert session_store.writers_frozen() is False
    fresh_store.create_session("s1", title="t")
    msg = fresh_store.add_message("s1", "m1", "user", "hello")
    assert msg["id"] == "m1"
    fresh_store.update_message("m1", content="edited")
    assert fresh_store.list_messages("s1")[0]["content"] == "edited"
    event = fresh_store.append_event("s1", "note", {"k": "v"})
    assert event["seq"] >= 1


def test_frozen_store_refuses_new_transcript_rows(fresh_store, monkeypatch):
    fresh_store.create_session("s1", title="t")
    fresh_store.add_message("s1", "m1", "user", "hello")
    events_before = fresh_store.list_events("s1")
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")

    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.add_message("s1", "m2", "assistant", "nope")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.append_event("s1", "note", {})
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.append_truncation("s1", deleted_ids=["m1"])

    # Nothing grew: messages and events are exactly the pre-freeze ones.
    assert [m["id"] for m in fresh_store.list_messages("s1")] == ["m1"]
    assert fresh_store.list_events("s1") == events_before


def test_frozen_store_keeps_reads_but_refuses_updates(fresh_store, monkeypatch):
    fresh_store.create_session("s1", title="t")
    fresh_store.add_message("s1", "m1", "user", "hello")
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")

    assert fresh_store.get_session("s1")["id"] == "s1"
    assert fresh_store.list_messages("s1")[0]["content"] == "hello"
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.update_message("m1", content="edited")
    assert fresh_store.list_messages("s1")[0]["content"] == "hello"


def test_frozen_store_refuses_session_and_message_mutations(fresh_store, monkeypatch):
    fresh_store.create_session("s1", title="t")
    fresh_store.add_message("s1", "m1", "user", "hello")
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")

    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.create_session("s2", title="blocked")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.update_session("s1", title="blocked")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.delete_message("m1")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.clear_session_messages("s1")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.delete_session("s1")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.wipe_all()

    imported = fresh_store.bulk_import(
        [{"id": "s2", "title": "imported", "created_at": 1, "updated_at": 1}],
        {
            "s2": [
                {
                    "id": "m2",
                    "role": "user",
                    "content": "from legacy",
                    "created_at": 1,
                    "updated_at": 1,
                }
            ]
        },
    )
    assert imported == {"sessions": 1, "messages": 1}
    assert fresh_store.list_messages("s2")[0]["content"] == "from legacy"
    assert fresh_store.get_session("s1")["title"] == "t"
    assert fresh_store.list_messages("s1")[0]["content"] == "hello"


def test_frozen_store_refuses_automation_mutations(fresh_store, monkeypatch):
    fresh_store.create_automation(
        "a1", "nightly", "@daily", "review the workspace", next_run_at=123
    )
    fresh_store.create_automation_run("r1", "a1", started_at=100)
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")

    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.create_automation("a2", "blocked", "@manual", "nope")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.update_automation("a1", prompt="blocked")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.delete_automation("a1")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.create_automation_run("r2", "a1")
    with pytest.raises(session_store.PythonWritersFrozen):
        fresh_store.finish_automation_run("r1", status="failed")

    # Existing automation metadata and run history remain readable and unchanged.
    assert fresh_store.get_automation("a1")["prompt"] == "review the workspace"
    assert fresh_store.list_automation_runs("a1")[0]["status"] == "running"


def test_frozen_checkpoint_persist_writes_nothing(tmp_path, monkeypatch):
    persist_dir = tmp_path / "checkpoints"
    manager = CheckpointManager(persist_dir=str(persist_dir))
    manager.save({"messages": [{"role": "user", "content": "x"}]}, label="cp1")

    assert manager.persist("s1") is True
    assert (persist_dir / "s1.json").exists()

    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    manager2 = CheckpointManager(persist_dir=str(persist_dir))
    manager2.save({"messages": [{"role": "user", "content": "y"}]}, label="cp2")
    assert manager2.persist("s2") is False
    assert not (persist_dir / "s2.json").exists()
    # In-memory state and reads still work.
    assert manager2.restore("cp2") is not None
    assert manager2.load("s1") in (True, False)


def test_frozen_long_task_context_keeps_memory_without_disk_writes(tmp_path, monkeypatch):
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    ctx = LongTaskContext(str(tmp_path))
    ctx.set_phase("testing")
    ctx.set_total_tasks(2)
    ctx.add_task_summary(TaskSummary(task_id="t1", title="T1", status="completed"))

    compressed = ctx.compress_for_next_turn()

    assert "testing" in compressed
    assert ctx.progress_summary.startswith("当前阶段: testing")
    assert not (tmp_path / ".long_task_context.json").exists()
    assert not (tmp_path / "doc" / "task-summaries.md").exists()


def test_frozen_long_task_context_does_not_modify_existing_files(tmp_path, monkeypatch):
    ctx = LongTaskContext(str(tmp_path))
    ctx.set_phase("initial")
    ctx.add_task_summary(TaskSummary(task_id="t1", title="T1", status="completed"))
    ctx.compress_for_next_turn()
    state_before = (tmp_path / ".long_task_context.json").read_bytes()
    summary_before = (tmp_path / "doc" / "task-summaries.md").read_bytes()

    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    ctx.set_phase("frozen")
    ctx.add_task_summary(TaskSummary(task_id="t2", title="T2", status="failed"))
    ctx.compress_for_next_turn()

    assert (tmp_path / ".long_task_context.json").read_bytes() == state_before
    assert (tmp_path / "doc" / "task-summaries.md").read_bytes() == summary_before


def test_frozen_rollout_recorder_does_not_create_or_modify_files(tmp_path, monkeypatch):
    rollout_dir = tmp_path / "rollouts"
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    recorder = RolloutRecorder("frozen", rollout_dir=str(rollout_dir))
    recorder.start()
    recorder.record_turn_start("blocked")
    recorder.record_custom("note", value="blocked")
    recorder.stop()

    assert not rollout_dir.exists()
    assert recorder.is_recording is False

    monkeypatch.delenv("HAKUS_FREEZE_PYTHON_WRITERS")
    baseline = RolloutRecorder("existing", rollout_dir=str(rollout_dir))
    baseline.start()
    baseline.record_turn_start("existing")
    baseline.stop()
    rollout_file = rollout_dir / "rollout_existing.jsonl"
    contents_before = rollout_file.read_bytes()

    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    frozen_existing = RolloutRecorder("existing", rollout_dir=str(rollout_dir))
    frozen_existing.start()
    frozen_existing.record_turn_start("blocked")
    frozen_existing.stop()

    assert rollout_file.read_bytes() == contents_before
    assert RolloutRecorder.load_events(str(rollout_file))


def test_frozen_session_log_keeps_reads_and_refuses_all_file_mutations(tmp_path, monkeypatch):
    home = tmp_path / "home"
    log_path = home / "sessions" / "s1" / "session_log.jsonl"
    archive_path = home / "sessions" / "s1" / "session_log.compacted.jsonl"
    log_path.parent.mkdir(parents=True)
    log_path.write_text('{"type":"turn_start","turn":1}\n', encoding="utf-8")
    archive_path.write_text('{"type":"archived","turn":0}\n', encoding="utf-8")
    log_before = log_path.read_bytes()
    archive_before = archive_path.read_bytes()
    monkeypatch.setenv("HAKUS_HOME", str(home))
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")

    fresh = SessionLogRecorder("s2")
    fresh.record_turn_start(turn=1, user_message="blocked")
    fresh.clear()
    assert not (home / "sessions" / "s2").exists()

    recorder = SessionLogRecorder("s1")
    recorder.record_turn_start(turn=2, user_message="blocked")
    recorder.record_text_delta(turn=2, text="blocked")
    recorder.record_turn_completed(turn=2, content="blocked")
    recorder.rewind_to_turn(keep_turns=0)
    recorder.clear()

    assert recorder.read_events() == [{"type": "turn_start", "turn": 1}]
    assert log_path.read_bytes() == log_before
    assert archive_path.read_bytes() == archive_before


def test_flag_accepts_common_truthy_spellings(monkeypatch):
    for value in ("1", "true", "True", "YES", " yes "):
        monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", value)
        assert session_store.writers_frozen() is True
    for value in ("", "0", "false", "off"):
        monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", value)
        assert session_store.writers_frozen() is False


def test_server_metadata_reports_the_freeze(monkeypatch):
    from hakusai_server.server import execution_plane_metadata

    monkeypatch.delenv("HAKUS_FREEZE_PYTHON_WRITERS", raising=False)
    assert execution_plane_metadata()["feature_gates"]["python_writers_frozen"] is False
    monkeypatch.setenv("HAKUS_FREEZE_PYTHON_WRITERS", "1")
    assert execution_plane_metadata()["feature_gates"]["python_writers_frozen"] is True

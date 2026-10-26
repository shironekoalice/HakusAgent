import copy
import json
import os
import time
import threading
from typing import Any, Dict, List, Optional

from utils.config import BASE_CONFIG
from utils.logger import get_logger
from .compat_writers import writers_frozen

logger = get_logger(__name__)


class Checkpoint:
    def __init__(
        self,
        checkpoint_id: str,
        messages: List[Dict[str, Any]],
        dynamic_context: Dict[str, str],
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.checkpoint_id = checkpoint_id
        self.messages = copy.deepcopy(messages)
        self.dynamic_context = copy.deepcopy(dynamic_context)
        self.metadata = metadata or {}
        self.timestamp = time.time()
        self.created_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.timestamp))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "checkpoint_id": self.checkpoint_id,
            "messages": self.messages,
            "dynamic_context": self.dynamic_context,
            "metadata": self.metadata,
            "timestamp": self.timestamp,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Checkpoint":
        # Support both old format (conversation_history + tool_results)
        # and new format (unified messages)
        if "messages" in data:
            messages = data["messages"]
        else:
            messages = data.get("conversation_history", []) + data.get("tool_results", [])

        cp = cls(
            checkpoint_id=data["checkpoint_id"],
            messages=messages,
            dynamic_context=data["dynamic_context"],
            metadata=data.get("metadata"),
        )
        cp.timestamp = data.get("timestamp", time.time())
        cp.created_at = data.get("created_at", "")
        return cp


class CheckpointManager:
    def __init__(
        self,
        max_checkpoints: int = 50,
        auto_checkpoint: bool = True,
        persist_dir: Optional[str] = None,
    ):
        self._checkpoints: Dict[str, Checkpoint] = {}
        self._checkpoint_order: List[str] = []
        self._max_checkpoints = max_checkpoints
        self._auto_checkpoint = auto_checkpoint
        self._auto_counter = 0
        self._lock = threading.Lock()

        self._persist_dir = persist_dir or os.path.join(
            BASE_CONFIG.get("STATE_DIR", "./state"), "checkpoints"
        )

    def save(
        self,
        context_snapshot: Dict[str, Any],
        label: Optional[str] = None,
        trigger: str = "manual",
    ) -> str:
        with self._lock:
            self._auto_counter += 1
            ts = time.strftime("%Y%m%d_%H%M%S")
            checkpoint_id = label or f"cp_{ts}_{self._auto_counter}"

            # Support both old format (conversation_history + tool_results)
            # and new format (unified messages)
            if "messages" in context_snapshot:
                messages = context_snapshot["messages"]
            else:
                messages = (context_snapshot.get("conversation_history", [])
                            + context_snapshot.get("tool_results", []))

            checkpoint = Checkpoint(
                checkpoint_id=checkpoint_id,
                messages=messages,
                dynamic_context=context_snapshot.get("dynamic_context", {}),
                metadata={
                    "trigger": trigger,
                    "compression_level": context_snapshot.get("compression_level"),
                    "compression_count": context_snapshot.get("compression_count", 0),
                    "circuit_breaker": context_snapshot.get("circuit_breaker", False),
                },
            )

            self._checkpoints[checkpoint_id] = checkpoint
            self._checkpoint_order.append(checkpoint_id)

            if len(self._checkpoints) > self._max_checkpoints:
                oldest_id = self._checkpoint_order.pop(0)
                self._checkpoints.pop(oldest_id, None)

            logger.debug(f"Checkpoint saved: {checkpoint_id} (trigger: {trigger})")
            return checkpoint_id

    def auto_save(self, context_snapshot: Dict[str, Any], trigger: str = "auto") -> str:
        if not self._auto_checkpoint:
            return ""
        return self.save(context_snapshot, trigger=trigger)

    def restore(self, checkpoint_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            checkpoint = self._checkpoints.get(checkpoint_id)
            if checkpoint is None:
                logger.warning(f"Checkpoint not found: {checkpoint_id}")
                return None

            return {
                "messages": copy.deepcopy(checkpoint.messages),
                "dynamic_context": copy.deepcopy(checkpoint.dynamic_context),
                "compression_level": checkpoint.metadata.get("compression_level", 0),
                "compression_count": checkpoint.metadata.get("compression_count", 0),
                "circuit_breaker": checkpoint.metadata.get("circuit_breaker", False),
            }

    def list_checkpoints(self) -> List[Dict[str, Any]]:
        with self._lock:
            result = []
            for cp_id in reversed(self._checkpoint_order):
                cp = self._checkpoints.get(cp_id)
                if cp:
                    result.append({
                        "id": cp.checkpoint_id,
                        "created_at": cp.created_at,
                        "trigger": cp.metadata.get("trigger", "unknown"),
                        "messages_length": len(cp.messages),
                    })
            return result

    def delete(self, checkpoint_id: str) -> bool:
        with self._lock:
            if checkpoint_id in self._checkpoints:
                del self._checkpoints[checkpoint_id]
                try:
                    self._checkpoint_order.remove(checkpoint_id)
                except ValueError:
                    pass
                return True
            return False

    def clear(self) -> None:
        with self._lock:
            self._checkpoints.clear()
            self._checkpoint_order.clear()
            self._auto_counter = 0

    def persist(self, session_id: str) -> bool:
        # Phase 0 migration gate (REFACTOR_STATUS "freeze new Python
        # transcript/checkpoint writers"): once frozen, no new checkpoint
        # bundles may appear on disk — they are a second authoritative
        # history the Phase 1 importer would have to reconcile. Reads
        # (load) and in-memory state keep working.
        if writers_frozen():
            logger.warning(
                "Checkpoint persist refused for session %s: Python writers are frozen "
                "(HAKUS_FREEZE_PYTHON_WRITERS)", session_id,
            )
            return False
        with self._lock:
            try:
                os.makedirs(self._persist_dir, exist_ok=True)
                filepath = os.path.join(self._persist_dir, f"{session_id}.json")
                data = {
                    "session_id": session_id,
                    "checkpoints": {
                        cp_id: cp.to_dict() for cp_id, cp in self._checkpoints.items()
                    },
                    "order": self._checkpoint_order,
                    "auto_counter": self._auto_counter,
                }
                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                logger.debug(f"Checkpoints persisted for session: {session_id}")
                return True
            except Exception as e:
                logger.error(f"Failed to persist checkpoints: {e}")
                return False

    def load(self, session_id: str) -> bool:
        with self._lock:
            try:
                filepath = os.path.join(self._persist_dir, f"{session_id}.json")
                if not os.path.exists(filepath):
                    return False

                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                self._checkpoints.clear()
                self._checkpoint_order.clear()

                for cp_id, cp_data in data.get("checkpoints", {}).items():
                    self._checkpoints[cp_id] = Checkpoint.from_dict(cp_data)

                self._checkpoint_order = data.get("order", [])
                self._auto_counter = data.get("auto_counter", 0)

                logger.info(f"Checkpoints loaded for session: {session_id} ({len(self._checkpoints)} checkpoints)")
                return True
            except Exception as e:
                logger.error(f"Failed to load checkpoints: {e}")
                return False

    def get_latest(self) -> Optional[str]:
        with self._lock:
            if self._checkpoint_order:
                return self._checkpoint_order[-1]
            return None

    def diff(self, checkpoint_id_a: str, checkpoint_id_b: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cp_a = self._checkpoints.get(checkpoint_id_a)
            cp_b = self._checkpoints.get(checkpoint_id_b)
            if not cp_a or not cp_b:
                return None

            return {
                "a": {
                    "id": cp_a.checkpoint_id,
                    "created_at": cp_a.created_at,
                    "messages_length": len(cp_a.messages),
                },
                "b": {
                    "id": cp_b.checkpoint_id,
                    "created_at": cp_b.created_at,
                    "messages_length": len(cp_b.messages),
                },
                "messages_diff": len(cp_b.messages) - len(cp_a.messages),
            }

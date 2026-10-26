"""跨 Turn 持久化上下文 — 长时任务执行期间维护跨 turn 的状态.

核心原则 (参照 Agents_structure/笔记-非最新仅参考-多智能体协同-长时工作设计.md):
1. 文件即记忆 — 所有产出持久化到文件,不依赖内存
2. 隔离即常态 — 每个子智能体只看到主智能体给它的信息
3. 主智能体上下文保护 — 不读子智能体产出内容,只接收路径和 PASS/FAIL
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

from utils.logger import get_logger
from .compat_writers import writers_frozen

logger = get_logger(__name__)


@dataclass
class TaskSummary:
    """已完成任务的摘要 — 用于主智能体上下文压缩."""
    task_id: str
    title: str
    status: str  # "completed" / "failed" / "low_quality_pass"
    test_result: str = ""  # "PASS" / "FAIL"
    fix_rounds: int = 0
    output_files: List[str] = field(default_factory=list)
    key_lessons: List[str] = field(default_factory=list)


class LongTaskContext:
    """跨 Turn 持久化上下文管理器.

    在长时任务执行期间维护:
    - workspace 状态 (文件清单、plan 路径、lessons 路径)
    - 经验库路径 (跨任务传递)
    - 任务进度摘要 (已完成任务的压缩摘要)
    - 当前 phase 和任务信息

    核心设计: 主智能体上下文只保留摘要,详细内容持久化到文件.
    """

    def __init__(self, workspace_dir: str):
        self._workspace_dir = Path(workspace_dir)
        self._state_file = self._workspace_dir / ".long_task_context.json"
        self._summaries: List[TaskSummary] = []
        self._current_phase: str = "idle"
        self._current_task: str = ""
        self._total_tasks: int = 0
        self._completed_tasks: int = 0
        self._lessons_file: str = str(self._workspace_dir / "doc" / "lessons-learned.md")
        self._plan_file: str = str(self._workspace_dir / "doc" / "plan.md")
        self._requirement: str = ""

    @property
    def workspace_dir(self) -> Path:
        return self._workspace_dir

    @property
    def lessons_file(self) -> str:
        return self._lessons_file

    @property
    def plan_file(self) -> str:
        return self._plan_file

    @property
    def current_phase(self) -> str:
        return self._current_phase

    @property
    def progress_summary(self) -> str:
        """人类可读的进度摘要 — 可直接注入主智能体上下文."""
        parts = [f"当前阶段: {self._current_phase}"]
        if self._total_tasks > 0:
            parts.append(f"任务进度: {self._completed_tasks}/{self._total_tasks}")
        if self._current_task:
            parts.append(f"当前任务: {self._current_task}")
        if self._summaries:
            completed = [s for s in self._summaries if s.status == "completed"]
            failed = [s for s in self._summaries if s.status == "failed"]
            parts.append(f"已完成: {len(completed)}, 失败: {len(failed)}")
        return " | ".join(parts)

    def set_phase(self, phase: str) -> None:
        self._current_phase = phase
        self._persist()

    def set_requirement(self, requirement: str) -> None:
        self._requirement = requirement
        self._persist()

    def set_total_tasks(self, total: int) -> None:
        self._total_tasks = total
        self._persist()

    def set_current_task(self, task_title: str) -> None:
        self._current_task = task_title
        self._persist()

    def add_task_summary(self, summary: TaskSummary) -> None:
        """添加已完成任务的摘要."""
        # Replace existing summary for same task_id
        self._summaries = [s for s in self._summaries if s.task_id != summary.task_id]
        self._summaries.append(summary)
        self._completed_tasks = len([s for s in self._summaries if s.status in ("completed", "low_quality_pass")])
        self._persist()

    def compress_for_next_turn(self) -> str:
        """将已完成任务摘要持久化到文件,返回可注入上下文的压缩摘要.

        核心原则: 主智能体上下文只保留:
        - 当前 phase
        - 任务进度摘要 (completed/total)
        - 经验库路径
        - 计划文件路径

        不保留:
        - 已完成任务的详细工具调用记录
        - 子智能体的完整输出
        - 测试报告的完整内容
        """
        # Persist summaries to file
        summary_path = self._workspace_dir / "doc" / "task-summaries.md"
        if not writers_frozen():
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            lines = ["# 任务进度摘要\n"]
            for s in self._summaries:
                status_icon = "✅" if s.status == "completed" else "⚠️" if s.status == "low_quality_pass" else "❌"
                lines.append(f"- {status_icon} {s.task_id}: {s.title} (测试: {s.test_result}, 修复轮次: {s.fix_rounds})")
            summary_path.write_text("\n".join(lines), encoding="utf-8")

        # Return compressed context for injection
        return (
            f"## 长时任务上下文\n"
            f"- 阶段: {self._current_phase}\n"
            f"- 进度: {self._completed_tasks}/{self._total_tasks}\n"
            f"- 经验库: {self._lessons_file}\n"
            f"- 计划: {self._plan_file}\n"
            f"- 摘要: {summary_path}\n"
        )

    def build_sub_agent_prompt(self, task_description: str, agent_type: str,
                                extra_context: Optional[Dict[str, Any]] = None) -> str:
        """为子智能体构建包含必读文件路径的 prompt.

        确保每个子智能体都能访问:
        - 开发计划
        - 经验库
        - 工作目录
        """
        parts = [f"## 任务\n{task_description}"]
        parts.append(f"\n## 工作目录\n{self._workspace_dir}")
        parts.append(f"\n## 开发计划\n{self._plan_file}")

        if agent_type == "dev":
            parts.append(f"\n## 经验教训 (必须先读)\n{self._lessons_file}")
            parts.append("\n## 重要\n请先阅读 lessons-learned.md 避免重复踩坑。")

        if agent_type == "tester":
            test_reports_dir = self._workspace_dir / "test-reports"
            parts.append(f"\n## 测试报告目录\n{test_reports_dir}")

        if extra_context:
            for key, value in extra_context.items():
                parts.append(f"\n## {key}\n{value}")

        return "\n".join(parts)

    def _persist(self) -> None:
        """持久化当前状态到文件."""
        if writers_frozen():
            return
        data = {
            "current_phase": self._current_phase,
            "current_task": self._current_task,
            "total_tasks": self._total_tasks,
            "completed_tasks": self._completed_tasks,
            "lessons_file": self._lessons_file,
            "plan_file": self._plan_file,
            "requirement": self._requirement,
            "summaries": [
                {
                    "task_id": s.task_id,
                    "title": s.title,
                    "status": s.status,
                    "test_result": s.test_result,
                    "fix_rounds": s.fix_rounds,
                    "output_files": s.output_files,
                    "key_lessons": s.key_lessons,
                }
                for s in self._summaries
            ],
        }
        try:
            self._state_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            logger.error(f"Failed to persist LongTaskContext: {e}")

    @classmethod
    def load(cls, workspace_dir: str) -> "LongTaskContext":
        """从文件加载持久化状态."""
        ctx = cls(workspace_dir)
        state_file = ctx._state_file
        if not state_file.exists():
            return ctx
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            ctx._current_phase = data.get("current_phase", "idle")
            ctx._current_task = data.get("current_task", "")
            ctx._total_tasks = data.get("total_tasks", 0)
            ctx._completed_tasks = data.get("completed_tasks", 0)
            ctx._lessons_file = data.get("lessons_file", ctx._lessons_file)
            ctx._plan_file = data.get("plan_file", ctx._plan_file)
            ctx._requirement = data.get("requirement", "")
            for sd in data.get("summaries", []):
                ctx._summaries.append(TaskSummary(
                    task_id=sd.get("task_id", ""),
                    title=sd.get("title", ""),
                    status=sd.get("status", ""),
                    test_result=sd.get("test_result", ""),
                    fix_rounds=sd.get("fix_rounds", 0),
                    output_files=sd.get("output_files", []),
                    key_lessons=sd.get("key_lessons", []),
                ))
        except Exception as e:
            logger.error(f"Failed to load LongTaskContext: {e}")
        return ctx

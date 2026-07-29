"""SCBench custom agent shim for Software Factory (#510).

Targets the pinned SlopCodeBench commit recorded in ../scbench.pin.json.
Registers the "software_factory" agent type. Every decision (brief
materialization, workspace handling, factory invocation, artifact
collection) lives in the tested TypeScript adapter under ../src — this
shim only shells out to its compiled CLI (../dist/cli.js) and never
touches GitHub issues, the queue, PRs, or merges itself.
"""

import json
import subprocess
import shutil
import tempfile
from pathlib import Path
from typing import Literal, Optional

from scbench.agents.base import Agent, AgentConfigBase, register_agent


class SoftwareFactoryConfig(AgentConfigBase, agent_type="software_factory", register=True):
    type: Literal["software_factory"] = "software_factory"
    node_bin: str = "node"
    adapter_cli: str = "packages/scbench-adapter/dist/cli.js"
    factory_bin: Optional[str] = None


class SoftwareFactoryAgent(Agent):
    def setup(self, session) -> None:
        self._workspace = str(session.workspace)
        self._artifacts_dir = str(session.artifacts_dir)
        self._last_result = None

    def run(self, task: str) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as task_file:
            task_file.write(task)
            task_path = task_file.name

        args = [
            self.config.node_bin,
            self.config.adapter_cli,
            "run-checkpoint",
            "--workspace",
            self._workspace,
            "--artifacts",
            self._artifacts_dir,
            "--task-file",
            task_path,
            "--problem",
            self.session.problem_id,
            "--checkpoint",
            self.session.checkpoint_id,
        ]
        if self.config.factory_bin:
            args += ["--factory-bin", self.config.factory_bin]

        proc = subprocess.run(args, capture_output=True, text=True)
        Path(task_path).unlink(missing_ok=True)
        if proc.returncode != 0:
            raise RuntimeError(f"scbench-factory-agent failed: {proc.stderr or proc.stdout}")

        self._last_result = json.loads(proc.stdout.strip().splitlines()[-1])

    def save_artifacts(self, path) -> None:
        if self._last_result and Path(self._last_result["artifactsDir"]).exists():
            shutil.copytree(self._last_result["artifactsDir"], path, dirs_exist_ok=True)

    def reset(self) -> None:
        # Factory is stateless per checkpoint; the workspace must persist
        # across checkpoints, so this is intentionally a no-op.
        pass

    def cleanup(self) -> None:
        # Never delete the workspace — it is SCBench's, not ours.
        pass


register_agent("software_factory", SoftwareFactoryAgent)

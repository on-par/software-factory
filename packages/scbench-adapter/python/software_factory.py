"""SCBench custom agent shim for Software Factory (#510, #521).

Targets the pinned SlopCodeBench commit recorded in ../scbench.pin.json.
Registers the "software_factory" agent type against the real pinned API
(slop_code.agent_runner) via import side effect — see
../python/run_scbench.py, the committed launcher that performs this
registration. Every decision (brief materialization, workspace handling,
factory invocation, artifact collection) lives in the tested TypeScript
adapter under ../src — this shim only shells out to its compiled CLI
(../dist/cli.js) and never touches GitHub issues, the queue, PRs, or
merges itself.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, Optional

from slop_code.agent_runner.agent import Agent, AgentConfigBase
from slop_code.agent_runner.models import AgentError
from slop_code.agent_runner.registry import register_agent


class SoftwareFactoryConfig(AgentConfigBase, agent_type="software_factory", register=True):
    type: Literal["software_factory"] = "software_factory"
    node_bin: str = "node"
    # None means "derive from this shim's own location": the shim lives in
    # packages/scbench-adapter/python/, the built CLI in
    # packages/scbench-adapter/dist/ — this keeps the committed run config
    # free of machine-specific absolute paths.
    adapter_cli: Optional[str] = None
    factory_bin: Optional[str] = None


class SoftwareFactoryAgent(Agent):
    def __init__(self, config: SoftwareFactoryConfig, problem_name: str, pricing, verbose: bool):
        super().__init__(
            agent_name="software_factory",
            problem_name=problem_name,
            cost_limits=config.cost_limits,
            pricing=pricing,
            verbose=verbose,
        )
        self._config = config
        self._workspace: Optional[Path] = None
        self._artifacts_root: Optional[Path] = None
        self._checkpoint_index = 0
        self._last_result: Optional[dict] = None

    @classmethod
    def _from_config(
        cls,
        config,
        model,
        credential,
        problem_name,
        verbose,
        image,
        thinking_preset=None,
        thinking_max_tokens=None,
    ) -> "SoftwareFactoryAgent":
        if not isinstance(config, SoftwareFactoryConfig):
            raise TypeError(f"expected SoftwareFactoryConfig, got {type(config)!r}")
        # credential/image/thinking params are accepted and ignored — Factory
        # routes its own models per packages/config.
        pricing = getattr(model, "pricing", None)
        return cls(config=config, problem_name=problem_name, pricing=pricing, verbose=verbose)

    def setup(self, session) -> None:
        self._workspace = Path(session.workspace.working_dir)
        # The brief and Factory artifacts must live outside the workspace so
        # they never appear in SCBench's diffs — same rule as the TS adapter.
        self._artifacts_root = Path(tempfile.mkdtemp(prefix="scbench-factory-artifacts-"))

    def run(self, task: str) -> None:
        if self._workspace is None:
            raise AgentError("setup() was not called")

        # SCBench does not pass a checkpoint id to run(); the counter must
        # live on the instance and must NOT be reset by reset() —
        # finish_checkpoint() calls reset() between checkpoints.
        self._checkpoint_index += 1
        checkpoint_id = f"cp-{self._checkpoint_index}"

        adapter_cli = self._config.adapter_cli or str(
            Path(__file__).resolve().parent.parent / "dist" / "cli.js"
        )
        if not Path(adapter_cli).exists():
            raise AgentError(
                f"adapter CLI not found at {adapter_cli} — build it with "
                "`npm run build --workspace @on-par/scbench-adapter`"
            )

        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as task_file:
            task_file.write(task)
            task_path = task_file.name

        args = [
            self._config.node_bin,
            adapter_cli,
            "run-checkpoint",
            "--workspace",
            str(self._workspace),
            "--artifacts",
            str(self._artifacts_root),
            "--task-file",
            task_path,
            "--problem",
            self.problem_name,
            "--checkpoint",
            checkpoint_id,
            "--index",
            str(self._checkpoint_index - 1),
        ]
        if self._config.factory_bin:
            args += ["--factory-bin", self._config.factory_bin]

        # Strip the leaked parent VIRTUAL_ENV (set by `uv run --project` on
        # the harness venv) so Factory checkpoints never inherit it — defense
        # in depth for entrypoints that skipped run_scbench.py's own
        # sanitization (#1164).
        env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}

        try:
            proc = subprocess.run(args, capture_output=True, text=True, env=env)
        finally:
            Path(task_path).unlink(missing_ok=True)

        if proc.returncode != 0:
            raise AgentError(f"scbench-factory-agent exited {proc.returncode}: {proc.stderr or proc.stdout}")

        self._last_result = json.loads(proc.stdout.strip().splitlines()[-1])

    def save_artifacts(self, path) -> None:
        if self._last_result and Path(self._last_result["artifactsDir"]).exists():
            shutil.copytree(self._last_result["artifactsDir"], path, dirs_exist_ok=True)

    def reset(self) -> None:
        # The workspace is SCBench's and persists across checkpoints; the
        # checkpoint counter must survive reset — only the last result clears.
        self._last_result = None

    def cleanup(self) -> None:
        # Remove only our own temp artifacts root — never touch the
        # workspace, which belongs to SCBench.
        if self._artifacts_root is not None:
            shutil.rmtree(self._artifacts_root, ignore_errors=True)


register_agent("software_factory", SoftwareFactoryAgent)

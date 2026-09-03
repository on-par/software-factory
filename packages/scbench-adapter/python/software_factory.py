"""SCBench custom agent shim for Software Factory (#510, #521).

Targets the pinned SlopCodeBench commit recorded in ../scbench.pin.json.
Registers the "software_factory" agent type against the real pinned API
(slop_code.agent_runner) via import side effect — see
../python/run_scbench.py, the committed launcher that performs this
registration. Every decision (brief materialization, workspace handling,
factory invocation, artifact collection) lives in the tested TypeScript
adapter under ../src — this shim only shells out to its compiled CLI
(../dist/cli.js) and never touches GitHub issues, the queue, PRs, or
merges itself. That includes the auto-rework hook (#1192): after each
checkpoint's hidden eval the shim shells out once to the CLI's
`retry-checkpoint` subcommand — every skip/red/fail-closed decision
stays in the tested TypeScript.
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
        # Auto-rework bookkeeping (#1192) — like _checkpoint_index, these
        # must survive reset() so run(N+1)/cleanup() can rework checkpoint N.
        self._pending_agent_dir: Optional[Path] = None
        self._last_task: Optional[str] = None
        self._last_checkpoint_id: Optional[str] = None
        self._last_checkpoint_index = 0

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

    def _adapter_cli(self) -> str:
        return self._config.adapter_cli or str(
            Path(__file__).resolve().parent.parent / "dist" / "cli.js"
        )

    def run(self, task: str) -> None:
        # The pinned Agent API has no post-eval hook, so the previous
        # checkpoint's rework fires at the next agent entry point (#1192).
        self._maybe_rework_previous()
        if self._workspace is None:
            raise AgentError("setup() was not called")

        # SCBench does not pass a checkpoint id to run(); the counter must
        # live on the instance and must NOT be reset by reset() —
        # finish_checkpoint() calls reset() between checkpoints.
        self._checkpoint_index += 1
        checkpoint_id = f"cp-{self._checkpoint_index}"
        self._last_task = task
        self._last_checkpoint_id = checkpoint_id
        self._last_checkpoint_index = self._checkpoint_index - 1

        adapter_cli = self._adapter_cli()
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
        # At the pinned commit `path` is <checkpoint_save_dir>/agent, whose
        # parent will hold the native evaluation.json; the auto-rework hook
        # reads it there. (Under compress_artifacts this is a temp dir — the
        # existence guard in _maybe_rework_previous makes that a silent skip.)
        self._pending_agent_dir = Path(path)

    def reset(self) -> None:
        # The workspace is SCBench's and persists across checkpoints; the
        # checkpoint counter must survive reset — only the last result clears.
        self._last_result = None

    def cleanup(self) -> None:
        # The final checkpoint's rework must run before the artifacts root —
        # the rework source directory being mirrored — is destroyed.
        self._maybe_rework_previous()
        # Remove only our own temp artifacts root — never touch the
        # workspace, which belongs to SCBench.
        if self._artifacts_root is not None:
            shutil.rmtree(self._artifacts_root, ignore_errors=True)

    def _maybe_rework_previous(self) -> None:
        """After checkpoint N's hidden eval, run its one ADR-0071 rework (#1192).

        Called at the next agent entry point (next run(), or cleanup() for the
        final checkpoint) — the pinned Agent API has no post-eval hook. Consumes
        the pending record first so the attempt is structurally once-only; every
        green/infra/duplicate decision stays in the tested TS subcommand.
        Best-effort: any failure is logged, never raised.
        """
        agent_dir, self._pending_agent_dir = self._pending_agent_dir, None
        if agent_dir is None or self._last_task is None or self._last_checkpoint_id is None:
            return
        if self._workspace is None or self._artifacts_root is None:
            return
        eval_path = agent_dir.parent / "evaluation.json"
        if not eval_path.exists():
            print(
                f"software_factory: no evaluation.json for {self._last_checkpoint_id} — rework skipped",
                flush=True,
            )
            return
        try:
            adapter_cli = self._adapter_cli()
            if not Path(adapter_cli).exists():
                print(
                    f"software_factory: adapter CLI missing at {adapter_cli} — rework skipped",
                    flush=True,
                )
                return
            with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as task_file:
                task_file.write(self._last_task)
                task_path = task_file.name
            args = [
                self._config.node_bin,
                adapter_cli,
                "retry-checkpoint",
                "--workspace",
                str(self._workspace),
                "--artifacts",
                str(self._artifacts_root),
                "--task-file",
                task_path,
                "--problem",
                self.problem_name,
                "--checkpoint",
                self._last_checkpoint_id,
                "--index",
                str(self._last_checkpoint_index),
                "--evaluation",
                str(eval_path),
            ]
            if self._config.factory_bin:
                args += ["--factory-bin", self._config.factory_bin]
            env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
            try:
                proc = subprocess.run(args, capture_output=True, text=True, env=env)
            finally:
                Path(task_path).unlink(missing_ok=True)
            for line in (proc.stdout + proc.stderr).splitlines():
                print(f"software_factory rework: {line}", flush=True)
            if proc.returncode == 0:
                result = json.loads(proc.stdout.strip().splitlines()[-1])
                rework_src = Path(result["artifactsDir"])
                if rework_src.exists():
                    # Mirror rework-1/ into the run output tree — the temp
                    # artifacts root is destroyed by cleanup().
                    shutil.copytree(rework_src, agent_dir / "rework-1", dirs_exist_ok=True)
            # returncode 1 = not retryable (reason already printed above);
            # returncode 2 = adapter error (printed above) — never fatal.
        except Exception as err:  # noqa: BLE001 — rework is best-effort by design
            print(f"software_factory: rework for {self._last_checkpoint_id} failed: {err}", flush=True)

register_agent("software_factory", SoftwareFactoryAgent)

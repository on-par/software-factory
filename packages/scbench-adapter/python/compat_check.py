"""Pinned-upstream compatibility check for the Software Factory SCBench shim.

Proves the full adapter contract against a real checkout of SlopCodeBench at
the commit pinned in ../scbench.pin.json. Requires network (to have cloned
the checkout) and the checkout's own `uv` environment — this script is not
part of `scripts/verify.sh` / CI, which stay offline and deterministic.
Run it like this:

    uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/compat_check.py

Exits 0 and prints a PASS summary on success; raises SystemExit(1) with an
instructive message on any failure.
"""
import json
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER_ROOT = HERE.parent
PIN_PATH = ADAPTER_ROOT / "scbench.pin.json"
RUN_CONFIG_PATH = ADAPTER_ROOT / "scbench.run.yaml"

sys.path.insert(0, str(HERE))


def _check_git_pin(checkout: Path, pinned_sha: str, label: str) -> None:
    """Fails unless `checkout`'s git HEAD matches `pinned_sha`, naming `label`
    in the error/warning message. Shared by check_pin() and
    check_problem_catalog() — both pin a git checkout to a commit recorded in
    scbench.pin.json and both downgrade drift to a warning under the same
    SCBENCH_PIN_ALLOW_DRIFT=1 escape hatch."""
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    actual_sha = result.stdout.strip()
    if actual_sha != pinned_sha:
        message = f"{label} HEAD {actual_sha} does not match pinned commit {pinned_sha} (scbench.pin.json)"
        if os.environ.get("SCBENCH_PIN_ALLOW_DRIFT") == "1":
            print(f"warning: {message}")
        else:
            raise SystemExit(f"error: {message}")


def check_pin() -> Path:
    """Loads the pin file and returns the pinned checkout's root, failing
    unless the checkout's git HEAD matches the pinned commit."""
    import slop_code

    pin = json.loads(PIN_PATH.read_text())
    # src layout: <checkout>/src/slop_code/__init__.py
    checkout = Path(slop_code.__file__).resolve().parents[2]

    pinned_sha = pin["commit"]
    _check_git_pin(checkout, pinned_sha, "checkout")
    print(f"ok: checkout HEAD matches pinned commit {pinned_sha}")
    return checkout


def check_problem_catalog():
    """Refuses to proceed unless SCBENCH_PROBLEMS_PATH points at a checkout of
    the pinned scb-problems catalog commit, and verifies the baseline's
    resolved problem ids each have a config.yaml directory there. Baseline
    runs never use the auto-synced ~/.cache/scbench catalog."""
    pin = json.loads(PIN_PATH.read_text())
    pinned_sha = pin["problems"]["commit"]

    override = os.environ.get("SCBENCH_PROBLEMS_PATH")
    if not override:
        raise SystemExit(
            "error: SCBENCH_PROBLEMS_PATH must point to a checkout of the pinned scb-problems "
            "catalog — baseline runs never use the auto-synced ~/.cache/scbench catalog"
        )
    catalog = Path(override)
    if not catalog.is_dir():
        raise SystemExit(f"error: SCBENCH_PROBLEMS_PATH {catalog} is not an existing directory")

    _check_git_pin(catalog, pinned_sha, "SCBENCH_PROBLEMS_PATH checkout")

    baseline_config_path = ADAPTER_ROOT.parent.parent / "evals" / "scbench-baseline" / "baseline.config.json"
    baseline_config = json.loads(baseline_config_path.read_text())
    problem_ids = [baseline_config["problems"]["smoke"], *baseline_config["problems"]["suite"]]
    for problem_id in problem_ids:
        if not (catalog / problem_id / "config.yaml").exists():
            raise SystemExit(
                f"error: problem id {problem_id!r} (from {baseline_config_path}) has no "
                f"config.yaml directory in the catalog checkout at {catalog}"
            )

    print(f"ok: resolved problem ids verified against catalog checkout: {', '.join(problem_ids)}")


def check_registration():
    """Imports the shim and asserts it registered against the real registries."""
    import software_factory
    from slop_code.agent_runner.registry import get_agent_cls, get_agent_config_cls

    assert get_agent_config_cls("software_factory") is software_factory.SoftwareFactoryConfig
    assert get_agent_cls("software_factory") is software_factory.SoftwareFactoryAgent
    print("ok: software_factory registered in both upstream registries")
    return software_factory


def check_config_loading(software_factory, adapter_cli: Path, factory_bin: Path):
    """Builds SoftwareFactoryConfig from the committed run config, then a
    second time with overrides pointing at real paths for this run."""
    import yaml
    from slop_code.agent_runner.registry import build_agent_config

    run_cfg = yaml.safe_load(RUN_CONFIG_PATH.read_text())
    cfg = build_agent_config(run_cfg["agent"])
    assert isinstance(cfg, software_factory.SoftwareFactoryConfig)
    assert cfg.cost_limits.cost_limit == 0
    print("ok: SoftwareFactoryConfig loads from the committed scbench.run.yaml")

    overrides = dict(run_cfg["agent"])
    overrides["adapter_cli"] = str(adapter_cli)
    overrides["factory_bin"] = str(factory_bin)
    cfg2 = build_agent_config(overrides)
    assert isinstance(cfg2, software_factory.SoftwareFactoryConfig)
    print("ok: SoftwareFactoryConfig loads with overridden adapter_cli/factory_bin")
    return cfg2


def check_adapter_cli() -> Path:
    adapter_cli = ADAPTER_ROOT / "dist" / "cli.js"
    if not adapter_cli.exists():
        raise SystemExit(
            f"error: adapter CLI not found at {adapter_cli} — build it with "
            "`npm run build --workspace @on-par/scbench-adapter`"
        )
    print(f"ok: adapter CLI present at {adapter_cli}")
    return adapter_cli


def write_stub_factory_bin() -> Path:
    """Writes an executable stub `factory` binary that mimics `factory
    run-brief --workspace <ws> --artifacts <dir>`: it marks the workspace and
    writes a manifest.json matching minimalManifest()'s shape."""
    stub_dir = Path(tempfile.mkdtemp(prefix="scbench-compat-factory-bin-"))
    stub_path = stub_dir / "factory"
    stub_path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "from pathlib import Path\n"
        "\n"
        "args = sys.argv[1:]\n"
        "\n"
        "def flag(name):\n"
        "    return args[args.index(name) + 1]\n"
        "\n"
        "ws = Path(flag('--workspace'))\n"
        "artifacts = Path(flag('--artifacts'))\n"
        "artifacts.mkdir(parents=True, exist_ok=True)\n"
        "\n"
        "existing = sorted(ws.glob('factory-touched-cp*.txt'))\n"
        "n = len(existing) + 1\n"
        "(ws / f'factory-touched-cp{n}.txt').write_text('touched')\n"
        "(artifacts / 'brief.md').write_text('stub brief')\n"
        "\n"
        "manifest = {\n"
        "    'manifestVersion': 1,\n"
        "    'run': {\n"
        "        'issue': 9000001,\n"
        "        'profile': 'local-only',\n"
        "        'outcome': 'ready',\n"
        "        'startedAt': '2026-07-28T00:00:00.000Z',\n"
        "        'endedAt': '2026-07-28T00:01:00.000Z',\n"
        "        'elapsedMs': 60000,\n"
        "        'workspace': str(ws),\n"
        "    },\n"
        "    'phases': {'plan': 'ok', 'build': 'ok', 'check': 'ok', 'ship': 'skipped'},\n"
        "    'modelAttempts': [],\n"
        "    'cost': {'totalUsd': 0, 'inputTokens': 0, 'outputTokens': 0, 'entries': []},\n"
        "    'git': {'changedFiles': [], 'diffStat': '', 'diffBase': 'HEAD'},\n"
        "    'artifacts': {\n"
        "        'manifest': 'manifest.json',\n"
        "        'request': 'request.json',\n"
        "        'events': 'events.ndjson',\n"
        "        'diff': 'diff.patch',\n"
        "    },\n"
        "}\n"
        "(artifacts / 'manifest.json').write_text(json.dumps(manifest))\n"
        "sys.exit(0)\n"
    )
    stub_path.chmod(stub_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print(f"ok: stub factory binary written to {stub_path}")
    return stub_path


def check_agent_lifecycle(software_factory, cfg2, checkout: Path):
    """Constructs the agent, drives setup + two run() checkpoints against a
    real Session, and asserts artifact handoff + workspace persistence."""
    from slop_code.execution import Session
    from slop_code.execution.local_streaming import LocalEnvironmentSpec
    import yaml

    agent = software_factory.SoftwareFactoryAgent._from_config(
        config=cfg2,
        model=None,
        credential=None,
        problem_name="compat-check",
        verbose=False,
        image=None,
    )
    print("ok: SoftwareFactoryAgent constructed via _from_config (all abstract members implemented)")

    env_yaml = (checkout / "configs" / "environments" / "local-py.yaml").read_text()
    spec = LocalEnvironmentSpec.model_validate(yaml.safe_load(env_yaml))
    session = Session.from_environment_spec(spec=spec, base_dir=None, static_assets=None, is_agent_infer=True)
    session.__enter__()
    try:
        agent.setup(session=session)
        ws = Path(session.workspace.working_dir)
        print(f"ok: agent.setup() resolved workspace {ws}")

        agent.run("Compat check: checkpoint one.")
        assert agent._last_result["outcome"] == "ready"
        assert (ws / "factory-touched-cp1.txt").exists()
        assert Path(agent._last_result["manifestPath"]).exists()
        print("ok: checkpoint one ran and produced a valid manifest")

        agent.finish_checkpoint(reset_context=True)
        assert agent._last_result is None
        print("ok: finish_checkpoint() reset the last result but preserved the checkpoint counter")

        first_artifacts_dir = agent._artifacts_root
        agent.run("Compat check: checkpoint two.")
        assert (ws / "factory-touched-cp1.txt").exists()
        assert (ws / "factory-touched-cp2.txt").exists()
        assert Path(agent._last_result["artifactsDir"]) != first_artifacts_dir
        print("ok: checkpoint two ran; workspace persisted across checkpoints")

        dest = Path(tempfile.mkdtemp(prefix="scbench-compat-artifacts-"))
        agent.save_artifacts(dest)
        assert (dest / "manifest.json").exists()
        assert (dest / "brief.md").exists()
        print("ok: save_artifacts() copied manifest.json and brief.md")

        agent.cleanup()
        assert ws.exists()
        assert (ws / "factory-touched-cp1.txt").exists()
        assert (ws / "factory-touched-cp2.txt").exists()
        print("ok: cleanup() left the SCBench workspace and its markers intact")
    finally:
        agent.cleanup()
        session.__exit__(None, None, None)


def main():
    checkout = check_pin()
    check_problem_catalog()
    software_factory = check_registration()
    adapter_cli = check_adapter_cli()
    factory_bin = write_stub_factory_bin()
    cfg2 = check_config_loading(software_factory, adapter_cli, factory_bin)
    check_agent_lifecycle(software_factory, cfg2, checkout)

    pin = json.loads(PIN_PATH.read_text())
    print(f"PASS: software_factory adapter is compatible with SCBench @ {pin['commit']}")


if __name__ == "__main__":
    main()

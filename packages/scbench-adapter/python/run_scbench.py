"""Runs SCBench's `slop-code` CLI with the Software Factory agent registered.

The SCBench revision pinned in ../scbench.pin.json has no custom-agent
discovery: registration happens by import side effect. This launcher imports
the shim, then hands argv to slop-code's own typer app. Before any `run`
invocation, it also enforces the catalog guard itself (missing, wrong-commit,
dirty, or non-git SCBENCH_PROBLEMS_PATH checkouts are refused) rather than
relying on the operator having run the compat_check preflight. Run it inside
the pinned checkout's uv environment:

    uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/run_scbench.py \\
        run --config packages/scbench-adapter/scbench.run.yaml --problem <problem-id>
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import software_factory  # noqa: F401  (import registers the agent)
from compat_check import check_problem_catalog
from slop_code.entrypoints.cli import app

if __name__ == "__main__":
    # The launcher runs inside `uv run --project $SCBENCH_CHECKOUT`, which sets
    # VIRTUAL_ENV to the harness venv. Evaluated temp projects and Factory
    # checkpoints must not inherit it — uv warns and ignores a mismatched
    # VIRTUAL_ENV, polluting evaluation stderr (#1164).
    os.environ.pop("VIRTUAL_ENV", None)
    # A baseline `run` must refuse mutable or missing catalog inputs itself —
    # never rely on the operator having run the compat_check preflight.
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        check_problem_catalog()
    app()

"""Runs SCBench's `slop-code` CLI with the Software Factory agent registered.

The SCBench revision pinned in ../scbench.pin.json has no custom-agent
discovery: registration happens by import side effect. This launcher imports
the shim, then hands argv to slop-code's own typer app. Run it inside the
pinned checkout's uv environment:

    uv run --project "$SCBENCH_CHECKOUT" python packages/scbench-adapter/python/run_scbench.py \\
        run --config packages/scbench-adapter/scbench.run.yaml --problem <problem-id>
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import software_factory  # noqa: F401  (import registers the agent)
from slop_code.entrypoints.cli import app

if __name__ == "__main__":
    app()

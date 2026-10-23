#!/usr/bin/env pwsh
# Runs the test suite the way CI does: restore once, then test without rebuilding twice.
$ErrorActionPreference = 'Stop'
dotnet restore App.sln
dotnet test App.sln --no-restore
exit $LASTEXITCODE

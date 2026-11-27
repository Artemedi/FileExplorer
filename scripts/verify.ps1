# Run from a dedicated worktree. Compatible with Windows PowerShell 5.1 and pwsh.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'verify.mjs') @args
exit $LASTEXITCODE

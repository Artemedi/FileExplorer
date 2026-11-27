# Local-first verification

Linux and Windows are the supported verification platforms. macOS is not part of the current acceptance scope. GitHub CI remains unchanged as an independent pre-merge and post-merge check, not the primary debugging environment.

## Workflow

1. Use a dedicated Git worktree. Reproduce the defect, apply the minimal fix, and stage all intended changes. Do not mix unrelated changes.
2. Run the same automated gate on Linux and Windows against the **same Git tree**. Run in parallel on separate machines when practical. Compare the report revision.tree values. An unstaged edit or an untracked non-ignored file is a preflight failure. Review the staged diff and make sure no ignored local input affects the build.
3. For affected native behavior, run actual GUI/SSH acceptance separately on each relevant platform, in an isolated test environment (never against production hosts). Record the tree, platform, binary identity, test command, logs, outcome, and exclusions. A successful build is not a successful GUI test. For a test-only or documentation change, explicitly justify N/A for native scenarios rather than silently counting them as PASS.
4. Commit after both automated gates pass and relevant native acceptance passes. Confirm the committed tree equals both tested tree IDs, with a clean tracked working tree. Push only the verified commit; summarize evidence and limitations in the PR. If CI fails, reproduce and resolve before pushing another fix. Do not bypass checks.
5. Merge only after exact-head CI succeeds and the base remains compatible. Confirm the merged tree matches the tested tree (or reverify a changed tree), then require post-merge CI. Release readiness is a separate decision.

## Running

Prerequisites: Git, Node.js 22 (or compatible version supported by the locked dependencies), npm, Rust with rustfmt and Clippy, and Tauri platform build prerequisites (Linux WebKitGTK/GTK development packages; Windows MSVC build tools and WebView2). Use the same toolchain versions as CI where practical; the report records actual versions. Run from a dedicated checkout, not a production or concurrently edited worktree.

Linux:
```bash
./scripts/verify.sh
```

Windows (PowerShell):
```powershell
.\scripts\verify.ps1
```

The two wrappers invoke a single Node.js implementation. No additional npm dependencies are required. The commands include lockfile-based npm ci, typecheck, frontend tests (including codebase audit), frontend build, Rust formatting, Clippy, default Rust tests, all-features test compilation and a native custom-protocol debug build. This is not a release installer build. The default Rust test selection matches CI; do not run all-features tests against live external services.

npm ci recreates node_modules in the worktree and prefers the existing npm cache. Do not point node_modules at a shared directory. Cargo reuses its normal registry and target caches. To reuse compiled artifacts across successive worktrees, set CARGO_TARGET_DIR to a dedicated local directory and CARGO_BUILD_JOBS to a suitable concurrency limit; do not use the same target directory for simultaneous verification runs. Cargo --locked forbids implicit lockfile updates. An isolated EXPLR_DATA_DIR under each report directory protects existing app settings. On immutable Linux, run in a locally provisioned container with the same prerequisites, persistent caches and isolated test data; the container must have access to the complete Git worktree or a standalone checkout of the same tree.

## Evidence contract

The runner prints the absolute REPORT path and writes report.json plus per-command logs in a fresh directory under the OS temporary directory (override its parent with EXPLR_VERIFY_REPORT_ROOT, outside the worktree). Preserve these files locally; publish a concise evidence summary in the PR, not sensitive logs or runtime data.

- revision.head is the starting commit; revision.tree is the staged candidate tree; revision.head_tree is the starting commit's tree. A staged candidate can be tested before creating the commit.
- Each command has status, exit_code, duration_ms and a log when executed. The automated gate passes only when every required step passes and the final candidate tree is unchanged. A failure returns a nonzero process exit; skipped steps remain NOT_RUN. An interrupted or killed process may leave RUNNING/INCOMPLETE; never treat it as PASS.
- native_gui_ssh and integration_gate remain NOT_RUN in this automated report. Attach separate evidence or an explicit scoped N/A decision. Neither is silently inferred from compilation.
- Identical Git tree IDs compare tracked canonical contents, not host-specific toolchains, ignored files or environment. Local tests are not a substitute for independent CI. The runner is not a sandbox; isolate test machines and data, and review logs before sharing.

## Acceptance

Automated Linux PASS + automated Windows PASS + identical candidate tree + affected native acceptance + reviewed diff = local publish gate. Exact-head GitHub CI and post-merge CI remain required for integration closure. No unconditional retries, timeout inflation in production, or ignored failures.

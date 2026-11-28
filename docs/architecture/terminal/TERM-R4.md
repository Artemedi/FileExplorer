# TERM-R4 implementation contract

Base: `a629b1d01259b978cffe3d3bb7e8960f7a2109ec`.

## R3.5 closure

Accepted on Linux Bazzite and Windows DBA-008D; UR-FINAL-006/007 merged in PR #10, UR-FINAL-009 in PR #11. UR009 tested tree `888f5f16479fef79279847e74038d2fb2beaa7fc`: 22 automated and 24 native scenario checks PASS. PR #11 exact-head CI [46121340197](https://github.com/Artemedi/FileExplorer/actions/runs/46121340197) and main post-merge CI [46123590187](https://github.com/Artemedi/FileExplorer/actions/runs/46123590187) SUCCESS. R3.5 accepted; no release.

## R4 design

A separate native Tauri WebView renders one existing Rust-owned PTY. The backend validates calling window identity and monotonic ownership epoch. The main window keeps its logical tab and a passive renderer for recovery; the detached window polls only its assigned journal and has no Explorer, credentials or event-plugin ACL. During detachment the existing Explorer binding is retained, but automatic directory synchronization is suspended. Return does not replay deferred cd commands.

The journal records ordered UTF-8 VT output, local clear and terminal geometry. Initial replay suppresses generated input. Limits: 8 MiB per session and 64 MiB total (accounted payload plus estimated record overhead), 16,384 frames, 128 frames/256 KiB per read. Overflow prevents bootstrapping from incomplete history; a detached reader that encounters a gap must return to the original view. Native window creation and close handoff have a bounded 10-second rollback.

## Verification status

This is an implementation candidate, not an accepted R4 release. Require fresh identical-tree local automated gates, real WebKitGTK and WebView2 detach/attach during active commands, OS-native close, TUI input/resize (T14), output/reply continuity during handoff (including DSR), isolation and cleanup (T13/T17). A native build or unit test alone is not equivalent to GUI acceptance. Do not publish until the required two-platform gates pass. macOS and release remain out of scope.

## UR-FINAL-010 — VT protocol responses

The xterm 6.0.0 public onData API merges user input and automatic replies. A narrow adapter preserves the internal CoreService.triggerDataEvent origin flag: the main parser alone forwards protocol replies over a main-only IPC command; detached replay suppresses them. User input and focus reports retain the normal owner/epoch guard. Both flows use the existing bounded main FIFO and SSH worker queue. The private xterm hook is lockfile-version sensitive and must be revalidated on dependency upgrades. The main WebView remains a trusted application boundary.

The production native probe also exposed an independent DECRQM crash: esbuild 0.25.12 under Vite 6.4.6 removes the local enum declaration in xterm requestMode. The ESM vendor module and the production build with syntax minification disabled retain the declaration. Disable only minifySyntax; keep other minification enabled. Revalidate this workaround against production WebKitGTK and WebView2 when upgrading the toolchain.

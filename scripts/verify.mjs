import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const parent = path.resolve(process.env.EXPLR_VERIFY_REPORT_ROOT || os.tmpdir());
fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, 'explr-verify-'));
const reportPath = path.join(dir, 'report.json');
const env = { ...process.env, EXPLR_DATA_DIR: path.join(dir, 'test-data') };
fs.mkdirSync(env.EXPLR_DATA_DIR);
const commands = [
    ['dependencies', 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']],
    ['typecheck', 'npm', ['run', 'typecheck']],
    ['frontend-tests', 'npm', ['test']],
    ['frontend-build', 'npm', ['run', 'build']],
    ['rust-format', 'cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']],
    ['rust-clippy', 'cargo', ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--all-targets', '--', '-D', 'warnings']],
    ['rust-tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']],
    ['rust-all-features', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--no-run', '--all-features']],
    ['native-build', 'cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--features', 'custom-protocol', '--bin', 'explr']],
];
const report = {
    schema: 1,
    started_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    revision: null,
    tools: { node: process.version },
    steps: [
        { name: 'preflight', status: 'NOT_RUN' },
        ...commands.map(([name, program, args]) => ({ name, command: [program, ...args], status: 'NOT_RUN' })),
        { name: 'source-integrity', status: 'NOT_RUN' },
    ],
    automated_gate: 'INCOMPLETE',
    native_gui_ssh: 'NOT_RUN',
    integration_gate: 'NOT_RUN',
};
function save() {
    fs.writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(reportPath + '.tmp', reportPath);
}
function invoke(program, args, options = {}) {
    // npm.cmd is a batch file on Windows. Only fixed internal commands/args
    // are passed to the shell; repository paths and user input are not interpolated.
    return spawnSync(program, args, {
        cwd: root, env, windowsHide: true,
        shell: windows && program === 'npm',
        ...options,
    });
}
function capture(program, args) {
    const result = invoke(program, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw new Error(program + ' ' + args.join(' ') + ': ' +
            (result.error?.message || result.stderr || 'exit ' + result.status));
    }
    return result.stdout.trim();
}
function snapshot() {
    // Stage the exact candidate first. No unstaged or untracked sources may
    // enter a verified tree. Ignored build products are not part of this tree.
    capture('git', ['diff', '--quiet', '--']);
    const untracked = capture('git', ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked) throw new Error('Untracked files exist; stage intended sources or use a clean worktree.');
    capture('git', ['diff', '--cached', '--check']);
    return {
        head: capture('git', ['rev-parse', 'HEAD']),
        tree: capture('git', ['write-tree']),
        head_tree: capture('git', ['rev-parse', 'HEAD^{tree}']),
    };
}
function action(step, fn) {
    const start = performance.now();
    step.status = 'RUNNING';
    save();
    console.log('RUN ' + step.name);
    try {
        fn();
        step.exit_code = 0;
        step.status = 'PASS';
    } catch (error) {
        step.exit_code = Number.isInteger(error.exitCode) ? error.exitCode : 1;
        step.error = String(error.message || error);
        step.status = 'FAIL';
        throw error;
    } finally {
        step.duration_ms = Math.round(performance.now() - start);
        save();
        console.log(step.status + ' ' + step.name + ' (' + step.duration_ms + ' ms)');
    }
}
const start = performance.now();
save();
console.log('REPORT=' + reportPath);
try {
    action(report.steps[0], () => {
        if (process.argv.length !== 2) throw new Error('No arguments supported; configure caches via environment.');
        if (!['linux', 'win32'].includes(process.platform)) throw new Error('Supported platforms: Linux and Windows.');
        report.revision = snapshot();
        const modules = path.join(root, 'node_modules');
        // npm ci removes node_modules. Never run it against a shared symlink/junction.
        if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) {
            throw new Error('node_modules must be owned by this worktree, not a symlink/junction.');
        }
        for (const [program, args] of [
            ['git', ['--version']], ['npm', ['--version']], ['rustc', ['-Vv']],
            ['cargo', ['-V']], ['rustfmt', ['--version']], ['cargo', ['clippy', '--version']],
        ]) {
            report.tools[args[0] === 'clippy' ? 'clippy' : program] = capture(program, args);
        }
    });
    for (const [i, [name, program, args]] of commands.entries()) {
        const step = report.steps[i + 1];
        action(step, () => {
            step.log = name + '.log';
            const fd = fs.openSync(path.join(dir, step.log), 'w');
            let result;
            try {
                result = invoke(program, args, { stdio: ['ignore', fd, fd] });
            } finally {
                fs.closeSync(fd);
            }
            if (result.error || result.status !== 0) {
                const error = new Error(result.error?.message || 'Command failed: ' + result.status + ' ' + (result.signal || ''));
                error.exitCode = result.status;
                throw error;
            }
        });
    }
    action(report.steps.at(-1), () => {
        if (JSON.stringify(snapshot()) !== JSON.stringify(report.revision)) {
            throw new Error('HEAD or candidate tree changed during verification.');
        }
    });
    report.automated_gate = 'PASS';
} catch (error) {
    report.automated_gate = 'FAIL';
    report.error = String(error.message || error);
    process.exitCode = 1;
    console.error(report.error);
} finally {
    report.finished_at = new Date().toISOString();
    report.duration_ms = Math.round(performance.now() - start);
    save();
    console.log('AUTOMATED_GATE=' + report.automated_gate);
    console.log('NATIVE_GUI_SSH=' + report.native_gui_ssh);
    console.log('REPORT=' + reportPath);
}

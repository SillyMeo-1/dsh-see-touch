/**
 * Locate the PowerShell a helper should run in.
 *
 * Windows PowerShell 5.1 starts C# compilation and JSON round-trips slower, and it
 * defaults to the machine code page; PowerShell 7 (pwsh) is UTF-8 and measurably
 * quicker. `auto` prefers pwsh when it is installed and falls back to 5.1, so a
 * machine without pwsh keeps working exactly as before.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Absolute locations checked after PATH. */
function pwshCandidates() {
	const candidates = [];
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env['ProgramFiles(x86)'];
	const localAppData = process.env.LOCALAPPDATA;
	if (typeof programFiles === 'string' && programFiles.length > 0) {
		candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
		candidates.push(join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'));
	}
	if (typeof programFilesX86 === 'string' && programFilesX86.length > 0) {
		candidates.push(join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'));
	}
	if (typeof localAppData === 'string' && localAppData.length > 0) {
		candidates.push(join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
	}
	return candidates;
}

/** First `pwsh.exe` found on PATH or in a standard install directory. */
function findPwsh() {
	const pathValue = process.env.PATH ?? process.env.Path ?? '';
	for (const raw of pathValue.split(';')) {
		const dir = raw.trim().replace(/^"|"$/gu, '');
		if (dir.length === 0) continue;
		const candidate = join(dir, 'pwsh.exe');
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// A broken PATH entry is not a reason to stop looking.
		}
	}
	for (const candidate of pwshCandidates()) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// Keep looking.
		}
	}
	return undefined;
}

/** Windows PowerShell 5.1, by absolute path when the system directory is known. */
function findWindowsPowerShell() {
	const root = process.env.SystemRoot;
	if (typeof root === 'string' && root.length > 0) {
		const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// Fall through to PATH resolution.
		}
	}
	return 'powershell.exe';
}

/**
 * Resolve the configured engine once, at plugin activation.
 *
 * An explicit `pwsh` that is not installed does not fail the plugin: the tools stay
 * visible and their first call reports which engine is missing. That keeps a bad
 * profile row from silently removing the eyes and hands.
 *
 * @param choice - 'auto' | 'pwsh' | 'powershell'.
 * @returns the executable to spawn, or a null exe plus a readable error.
 */
export function resolveShell(choice) {
	if (process.platform !== 'win32') {
		return {
			choice,
			exe: undefined,
			kind: 'unsupported',
			error: '「我看得见也摸得到」只能在 Windows 上驱动桌面；当前系统不是 Windows，工具不会执行任何操作。'
		};
	}
	if (choice === 'powershell') {
		return { choice, exe: findWindowsPowerShell(), kind: 'windows-powershell', error: undefined };
	}
	const pwsh = findPwsh();
	if (choice === 'pwsh') {
		if (pwsh === undefined) {
			return {
				choice,
				exe: undefined,
				kind: 'pwsh',
				error: '设置要求用 PowerShell 7（pwsh），但这台机器没找到 pwsh.exe。把它装进 PATH，或把设置改回 auto / powershell。'
			};
		}
		return { choice, exe: pwsh, kind: 'pwsh', error: undefined };
	}
	if (pwsh !== undefined) return { choice, exe: pwsh, kind: 'pwsh', error: undefined };
	return { choice, exe: findWindowsPowerShell(), kind: 'windows-powershell', error: undefined };
}

/** One readable line for the settings page. */
export function describeShell(shell) {
	if (shell.exe === undefined) return shell.error ?? '未找到可用的 PowerShell';
	return `${shell.kind === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell 5.1'} · ${shell.exe}`;
}

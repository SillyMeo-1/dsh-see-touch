import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './host/config.js';
import { registerSettingsApi } from './host/settings.js';
import { describeShell, resolveShell } from './host/shell.js';

/**
 * 我看得见也摸得到 — real-time desktop vision and control for the DeepSeek Harness.
 *
 * Two model-facing tools share ONE pixel space. `screen_view` captures the live
 * desktop and returns the PNG as a real image block, so the calling model sees the
 * actual screen rather than a description of it. `desktop_control` drives the mouse,
 * keyboard, and windows in the physical pixels that image is measured in, then
 * optionally captures again, closing the see/act/see loop.
 *
 * Both halves run through PowerShell child processes:
 * `lib/scripts/desktop-probe.ps1` (sensor) and `lib/scripts/desktop-action.ps1`
 * (effector). Each child makes itself per-monitor DPI aware before it does anything,
 * which is what keeps the reported geometry honest: DPI-unaware processes are lied
 * to by Windows and would report a 2560x1600 panel as 1707x1067, making every click
 * land in the wrong place.
 *
 * @module see-touch
 */

/** Stable Loader identity. */
const name = 'see-touch';

/** Services this plugin registers against. */
const inject = ['tools'];

/** Directory name for captured frames inside the session workspace (workspace mode only). */
const CAPTURE_DIRNAME = '.see-touch';

/** Temp-directory leaf shared by scratch files and temp-mode frames. */
const TEMP_DIRNAME = 'see-touch';

/** The engine resolved once per plugin activation. */
let shellRuntime = {
	choice: 'auto',
	exe: undefined,
	kind: 'unsupported',
	error: 'PowerShell 还没解析出来；请重新加载插件。'
};

/** Throw the resolved engine problem in a way the model can act on. */
function powershellExe() {
	if (typeof shellRuntime.exe === 'string' && shellRuntime.exe.length > 0) return shellRuntime.exe;
	throw new Error(`see-touch: ${shellRuntime.error ?? '找不到可用的 PowerShell'}`);
}

/**
 * Turn the compact value-schema shorthand into standard JSON Schema.
 *
 * The tool registry validates arguments and results against plain JSON Schema. The
 * shorthand used here (a `required: true` flag on each property) reads better next
 * to the field it belongs to, so it is converted once at registration instead of
 * being retyped as arrays by hand.
 *
 * @param spec - compact schema node.
 * @returns the same node as standard JSON Schema.
 */
function valueSchema(spec) {
	if (spec === null || typeof spec !== 'object') return spec;
	if (Array.isArray(spec)) return spec.map((entry) => valueSchema(entry));
	const out = { ...spec };
	if (out.properties !== null && typeof out.properties === 'object') {
		const properties = {};
		const required = [];
		for (const [key, child] of Object.entries(out.properties)) {
			if (child === null || typeof child !== 'object') {
				properties[key] = child;
				continue;
			}
			const { required: isRequired, ...rest } = child;
			properties[key] = valueSchema(rest);
			if (isRequired === true) required.push(key);
		}
		out.properties = properties;
		if (required.length > 0) out.required = required;
	}
	if (out.items !== undefined) out.items = valueSchema(out.items);
	return out;
}

/** Turn the compact parameter record into a closed JSON Schema object. */
function parameterSchema(spec) {
	const properties = {};
	const required = [];
	for (const [key, value] of Object.entries(spec ?? {})) {
		if (value === null || typeof value !== 'object') continue;
		const { required: isRequired, ...rest } = value;
		properties[key] = valueSchema(rest);
		if (isRequired === true) required.push(key);
	}
	return {
		type: 'object',
		additionalProperties: false,
		properties,
		...(required.length > 0 ? { required } : {})
	};
}

/** Registry-ready definition from the compact shape used below. */
function ownTool(options) {
	return {
		...options,
		parameters: parameterSchema(options.parameters),
		output: options.output === undefined ? undefined : { ...options.output, schema: valueSchema(options.output.schema) }
	};
}

/**
 * Absolute path of this package, resolved from the module URL rather than the
 * working directory, so the helper scripts are found wherever the profile
 * mounted the package from.
 * @returns the package root directory.
 */
function packageRoot() {
	return dirname(fileURLToPath(import.meta.url));
}

/** Path of the sensor script. */
function probeScript() {
	return join(packageRoot(), 'lib', 'scripts', 'desktop-probe.ps1');
}

/** Path of the effector script. */
function actionScript() {
	return join(packageRoot(), 'lib', 'scripts', 'desktop-action.ps1');
}

/** Path of the persistent worker (the warm path for actions). */
function workerScript() {
	return join(packageRoot(), 'lib', 'scripts', 'desktop-worker.ps1');
}

/** Root of the plugin's temp state: parameter files, cancel tokens, overlay state. */
function tempRoot() {
	// An explicit override exists so a test harness's batched clicks cannot paint the
	// ring of a session somebody is watching.
	const override = process.env.DSH_SEE_TOUCH_SCRATCH_DIR;
	if (typeof override === 'string' && override.trim().length > 0) return resolve(override.trim());
	return join(tmpdir(), TEMP_DIRNAME);
}

/** Scratch directory for parameter files and cancel tokens. */
function scratchDir() {
	const dir = tempRoot();
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Temp-mode capture directory. */
function tempCaptureDir() {
	return join(tempRoot(), 'captures');
}

/**
 * Remove helper leftovers older than a day, including old frames.
 *
 * A killed helper leaves its params/cancel file behind; the overlay leaves mute and
 * status files. Left alone they accumulate in %TEMP% forever. This runs once at
 * activation, before anything is in flight, so it cannot race a live action.
 *
 * @param config - validated plugin configuration.
 */
function cleanupStaleScratch(config) {
	const maxAgeMs = 24 * 60 * 60 * 1000;
	const now = Date.now();
	const root = tempRoot();
	try {
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const full = join(root, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'captures') {
					pruneCaptures(full, config);
					continue;
				}
				if (entry.name !== 'takeover') continue;
				try {
					for (const inner of readdirSync(full, { withFileTypes: true })) {
						if (!inner.isFile()) continue;
						const file = join(full, inner.name);
						try {
							if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
						} catch {
							// A file being rewritten by a live overlay is left for next time.
						}
					}
				} catch {
					// An unreadable overlay directory is not fatal.
				}
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				if (now - statSync(full).mtimeMs > maxAgeMs) rmSync(full, { force: true });
			} catch {
				// Housekeeping never fails activation.
			}
		}
	} catch {
		// Cleanup is best-effort.
	}
}

let sequence = 0;

/** Unique-enough file stem for one invocation. */
function nextToken() {
	sequence += 1;
	return `${Date.now().toString(36)}-${process.pid.toString(36)}-${sequence.toString(36)}`;
}

/**
 * Run one PowerShell helper to completion.
 *
 * Parameters travel through a UTF-8 file rather than the command line, so
 * non-ASCII window titles and paths survive regardless of the console code
 * page. When the caller's signal aborts, the cancel token is stamped and the
 * child is killed, which is what makes an interrupted turn stop a gesture in
 * flight instead of letting the remaining clicks play out.
 *
 * @param script - absolute path of the helper script.
 * @param params - parameter object serialized as JSON for the child.
 * @param signal - the tool execution signal.
 * @param timeoutMs - hard kill deadline in milliseconds.
 * @returns the parsed JSON result object.
 */
function runHelper(script, params, signal, timeoutMs, cancelPathOverride) {
	if (!existsSync(script)) throw new Error(`see-touch: helper script is missing at ${script}`);
	const dir = scratchDir();
	const token = nextToken();
	const paramsPath = join(dir, `params-${token}.json`);
	const cancelPath = cancelPathOverride ?? join(dir, `cancel-${token}.txt`);
	writeFileSync(paramsPath, JSON.stringify({ ...params, cancelFile: cancelPath }), 'utf8');

	return new Promise((resolvePromise, rejectPromise) => {
		let child;
		try {
			child = spawn(
				powershellExe(),
				['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParamsPath', paramsPath],
				{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
			);
		} catch (error) {
			rejectPromise(new Error(`see-touch: 启动 PowerShell 失败（${error instanceof Error ? error.message : String(error)}）`));
			return;
		}
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer;

		const cleanup = () => {
			clearTimeout(timer);
			for (const file of [paramsPath, cancelPath]) {
				try {
					rmSync(file, { force: true });
				} catch {
					// A leftover scratch file is harmless.
				}
			}
		};

		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		};

		const abort = () => {
			try {
				writeFileSync(cancelPath, 'stop', 'utf8');
			} catch {
				// The kill below is the authoritative stop.
			}
			try {
				child.kill();
			} catch {
				// Already gone.
			}
			finish(rejectPromise, new Error('see-touch: the action was cancelled before it completed'));
		};

		if (signal !== undefined) {
			if (signal.aborted) {
				finish(rejectPromise, new Error('see-touch: the action was cancelled before it started'));
				return;
			}
			signal.addEventListener('abort', abort, { once: true });
		}

		timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// Already gone.
			}
			finish(rejectPromise, new Error(`see-touch: the helper did not finish within ${timeoutMs} ms`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => {
			finish(rejectPromise, new Error(`see-touch: could not start PowerShell (${error.message})`));
		});
		child.on('close', (code) => {
			if (settled) return;
			signal?.removeEventListener('abort', abort);
			const payload = parseLastJson(stdout);
			if (payload === undefined) {
				const detail = stderr.trim().length > 0 ? stderr.trim() : `exit code ${code}`;
				finish(rejectPromise, new Error(`see-touch: the helper produced no result (${detail})`));
				return;
			}
			if (payload.ok !== true) {
				finish(rejectPromise, new Error(String(payload.error ?? 'see-touch: the helper reported a failure')));
				return;
			}
			finish(resolvePromise, payload);
		});
	});
}

/**
 * Read the last JSON object a helper printed. Helpers may emit assembly chatter
 * before their result, so the parse walks backwards line by line.
 * @param text - raw stdout.
 * @returns the parsed object, or undefined.
 */
function parseLastJson(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith('{') || !line.endsWith('}')) continue;
		try {
			return JSON.parse(line);
		} catch {
			// Keep looking further up.
		}
	}
	return undefined;
}

/** Options accepted by both helpers. */
function optionsFor(exec, config) {
	return {
		signal: exec.signal,
		timeoutMs: config.timeoutMs
	};
}

/** Exponential backoff for a worker that keeps dying: 300 ms → 60 s, capped. */
function workerBackoff(failures) {
	const step = Math.min(8, Math.max(1, failures));
	return Math.min(60000, 300 * 2 ** (step - 1));
}

/**
 * One long-lived PowerShell process that keeps the Win32 bridge compiled.
 *
 * Starting a process and compiling that bridge costs ~0.9 s, which a batch of
 * five steps used to pay five times. The worker pays it once and then answers a
 * request in single-digit milliseconds, so the cost of an action becomes the
 * action itself.
 *
 * Requests are serialized (one in flight, ids echoed back) because a single
 * stdout stream cannot be demultiplexed any other way. A request that times out
 * kills the worker: an action whose fate is unknown must not be retried silently,
 * and the next request starts a fresh worker.
 */
class ActionWorker {
	constructor() {
		this.child = undefined;
		this.ready = false;
		this.starting = undefined;
		/** True only while the promise in `starting` is still unsettled. */
		this.startingPending = false;
		this.waiters = [];
		this.queue = Promise.resolve();
		this.sequence = 0;
		this.buffer = '';
		/** Consecutive start failures, reset as soon as the ready line arrives. */
		this.startFailures = 0;
		/** Consecutive unexpected exits after a ready line, reset by a successful reply. */
		this.crashes = 0;
		/** No new worker is started before this instant. */
		this.retryAt = 0;
		/** True while the plugin is shutting the worker down on purpose. */
		this.stopping = false;
	}

	/** True while the worker is worth trying right now. */
	usable() {
		return this.stopping !== true && Date.now() >= this.retryAt;
	}

	/** Record one failure and push the next attempt back. */
	noteFailure(crash) {
		if (crash) this.crashes += 1;
		else this.startFailures += 1;
		this.retryAt = Date.now() + workerBackoff(Math.max(this.startFailures, this.crashes));
	}

	/** A healthy reply proves the warm path works again; forget the backoff. */
	noteSuccess() {
		this.crashes = 0;
		this.startFailures = 0;
		this.retryAt = 0;
	}

	/**
	 * Start the process once and wait for its ready line.
	 *
	 * A worker that exited is no longer a permanent verdict: after the backoff the
	 * next request tries a fresh process, which is what the original 0.7.4 comment
	 * promised and the code never did. Until then, callers fall back to the one-shot
	 * helper on their own.
	 *
	 * @param timeoutMs - how long the first start may take (the bridge compiles).
	 */
	async start(timeoutMs) {
		if (this.ready) return;
		if (this.startingPending === true) return this.starting;
		if (this.stopping) throw Object.assign(new Error('see-touch: the action worker is shutting down'), { transport: true });
		if (Date.now() < this.retryAt) {
			const seconds = Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000));
			throw Object.assign(new Error(`see-touch: the action worker is resting for ${seconds}s after a failure`), { transport: true });
		}
		this.startingPending = true;
		this.starting = new Promise((resolvePromise, rejectPromise) => {
			let settled = false;
			let timer;
			const settle = (error, crash = false) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.ready = false;
				// The start attempt is over, so a later request must be allowed to make
				// a fresh one. Leaving this promise in place made every request after a
				// crash return the already-resolved start and then hit a missing child.
				this.starting = undefined;
				this.startingPending = false;
				const child = this.child;
				this.child = undefined;
				try {
					child?.kill();
				} catch {
					// Already gone.
				}
				if (!this.stopping) this.noteFailure(crash);
				rejectPromise(Object.assign(error, { transport: true }));
			};
			timer = setTimeout(() => settle(new Error(`see-touch: the action worker did not start within ${timeoutMs} ms`)), timeoutMs);
			let child;
			try {
				child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerScript()], {
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true
				});
			} catch (error) {
				settle(new Error(`see-touch: could not start the action worker (${error.message})`));
				return;
			}
			this.child = child;
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk) => this.absorb(chunk));
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', () => {
				// Stray stderr is not fatal: the protocol lives on stdout.
			});
			child.on('error', (error) => {
				settle(new Error(`see-touch: the action worker failed (${error.message})`));
			});
			child.on('close', () => {
				const wasReady = this.ready;
				this.ready = false;
				if (this.child === child) this.child = undefined;
				const pending = this.waiters;
				this.waiters = [];
				for (const waiter of pending) {
					// The action may or may not have run: never retry it silently.
					waiter.reject(Object.assign(new Error('see-touch: the action worker exited before answering'), { transport: false }));
				}
				if (!settled) {
					settle(new Error('see-touch: the action worker exited during startup'));
				} else if (wasReady && !this.stopping) {
					// It had answered ready and then died: the next request may restart it
					// after the backoff instead of falling back forever.
					this.noteFailure(true);
				}
			});
			this.readyResolve = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.ready = true;
				this.startFailures = 0;
				this.retryAt = 0;
				this.starting = undefined;
				this.startingPending = false;
				resolvePromise();
			};
		});
		const promise = this.starting;
		promise.catch(() => {
			if (this.starting === promise) this.starting = undefined;
		});
		return promise;
	}

	/** Feed stdout through the line protocol. */
	absorb(chunk) {
		this.buffer += chunk;
		let index = this.buffer.indexOf('\n');
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line.length > 0) this.dispatch(line);
			index = this.buffer.indexOf('\n');
		}
	}

	/** Hand one response line to its waiter. */
	dispatch(line) {
		let payload;
		try {
			payload = JSON.parse(line);
		} catch {
			return; // Assembly chatter is not our business.
		}
		if (payload !== null && typeof payload === 'object' && payload.ready === true) {
			this.readyResolve?.();
			return;
		}
		const waiter = payload?.id === undefined
			? this.waiters.shift()
			: this.waiters.findIndex((entry) => entry.id === payload.id);
		const claim = typeof waiter === 'number' ? (waiter < 0 ? undefined : this.waiters.splice(waiter, 1)[0]) : waiter;
		if (claim === undefined) return;
		claim.settle(payload);
	}

	/**
	 * Run one action in the warm process.
	 * @param payload - the action request (cancelFile included by the caller).
	 * @param options - signal and timeout.
	 * @returns the parsed result of a successful action.
	 */
	request(payload, options) {
		const run = async () => {
			const started = Date.now();
			await this.start(Math.max(options.timeoutMs, 30000));
			const id = `r${(this.sequence += 1)}`;
			const budget = Math.max(1000, options.timeoutMs - (Date.now() - started));
			return await this.exchange({ ...payload, id }, id, budget, options);
		};
		const result = this.queue.then(run, run);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Write one request and await its response. */
	exchange(payload, id, timeoutMs, options) {
		return new Promise((resolvePromise, rejectPromise) => {
			let settled = false;
			const finish = (fn, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', abort);
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				fn(value);
			};
			const waiter = {
				id,
				settle: (value) => {
					if (value.ok === true) {
						// One answered request proves the warm path is healthy again.
						this.noteSuccess();
						finish(resolvePromise, value);
					} else finish(rejectPromise, Object.assign(new Error(String(value.error ?? 'see-touch: the action failed')), { cancelled: value.cancelled === true }));
				},
				// The worker can die while this request is in flight (the close handler
				// rejects through here). Without it that handler called an undefined
				// function and threw inside an event callback, so the pending request
				// never settled and the exception escaped to the host.
				reject: (error) => finish(rejectPromise, error)
			};
			const abort = () => {
				// The worker polls the cancel file between steps, so an
				// interrupted turn stops a gesture in flight.
				try {
					if (typeof payload.cancelFile === 'string') writeFileSync(payload.cancelFile, 'stop', 'utf8');
				} catch {
					// The kill below is the authoritative stop.
				}
			};
			const timer = setTimeout(() => {
				// Unknown fate: kill the worker so nothing keeps acting, and let
				// the caller see the failure rather than a silent retry.
				try {
					this.child?.kill();
				} catch {
					// Already gone.
				}
				finish(rejectPromise, Object.assign(new Error(`see-touch: the action did not finish within ${timeoutMs} ms`), { transport: false }));
			}, timeoutMs);
			this.waiters.push(waiter);
			if (options.signal !== undefined) {
				if (options.signal.aborted) abort();
				else options.signal.addEventListener('abort', abort, { once: true });
			}
			try {
				this.child.stdin.write(`${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}\n`);
			} catch (error) {
				// Nothing reached the child, so a fallback cannot double-act.
				finish(rejectPromise, Object.assign(new Error(`see-touch: could not reach the action worker (${error.message})`), { transport: true }));
			}
		});
	}

	/** Ask the worker to exit; a worker that ignores it is killed. */
	async stop() {
		this.stopping = true;
		try {
			const child = this.child;
			if (child === undefined) return;
			try {
				child.stdin.write(`${Buffer.from('{"quit":true}', 'utf8').toString('base64')}\n`);
			} catch {
				// Fall through to the kill.
			}
			await new Promise((resolvePromise) => {
				const timer = setTimeout(() => {
					try {
						child.kill();
					} catch {
						// Already gone.
					}
					resolvePromise();
				}, 1500);
				child.once('close', () => {
					clearTimeout(timer);
					resolvePromise();
				});
			});
		} finally {
			this.ready = false;
			this.child = undefined;
			// A later activation in the same host process must be able to start a new
			// worker; the intentional stop is over once the child is gone.
			this.stopping = false;
		}
	}
}

/** The warm action process, shared by every session in this host process. */
const actionWorker = new ActionWorker();

/**
 * Start the warm process in the background on first use.
 *
 * The ~1 s it needs (process start plus one C# compile) then overlaps whatever the
 * current call is already doing — usually a capture — instead of being paid by the
 * first action of the first batch. Failures stay silent here: each action falls
 * back to the one-shot script on its own.
 *
 * @param config - validated plugin configuration.
 */
function warmWorker(config) {
	if (config.useWorker === false) return;
	void actionWorker.start(30000).catch(() => undefined);
}

/**
 * Run one action: through the warm worker when it is available, otherwise through
 * the one-shot script, which is also the fallback when the worker cannot start.
 * A failure that happened *after* the request was delivered is never retried —
 * the action may already have taken effect.
 *
 * @param params - the action request.
 * @param config - validated plugin configuration.
 * @param options - signal and timeout.
 * @returns the parsed result.
 */
async function runAction(params, config, options, cancelPathOverride, label) {
	const ownsRing = cancelPathOverride === undefined;
	const cancelPath = cancelPathOverride ?? join(scratchDir(), `cancel-${nextToken()}.txt`);
	const startedAt = Date.now();
	const takeDir = ownsRing ? beginTakeover(cancelPath, config, label) : null;
	try {
		if (config.useWorker === false || !actionWorker.usable()) {
			return await runHelper(actionScript(), params, options.signal, options.timeoutMs, cancelPath);
		}
		try {
			return await actionWorker.request({ ...params, cancelFile: cancelPath }, options);
		} catch (error) {
			if (error?.transport === true) {
				return await runHelper(actionScript(), params, options.signal, options.timeoutMs, cancelPath);
			}
			// An abort and an Esc both land here as "cancelled"; only one of them was
			// a person deciding, and the model should be told which.
			if (error?.cancelled === true && tookEsc(takeDir, startedAt)) {
				throw Object.assign(new Error('see-touch: the person pressed Esc and cancelled this action'), { cancelled: true });
			}
			throw error;
		}
	} finally {
		endTakeover(takeDir, ownsRing ? cancelPath : undefined, config.takeoverLingerMs);
	}
}

/** The one overlay process, started the first time a takeover is worth showing. */
let overlayProcess = null;

/** Absolute path of the takeover overlay helper. */
function overlayScript() {
	return join(packageRoot(), 'lib', 'scripts', '_dsh-overlay.ps1');
}

/** Directory the overlay polls for its instructions. */
function takeoverDir() {
	const dir = join(scratchDir(), 'takeover');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** True when an overlay process from this state directory is still alive. */
function overlayInstanceAlive() {
	try {
		const raw = readFileSync(join(takeoverDir(), 'instance.txt'), 'utf8').trim();
		const pid = Number(raw);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ask the overlay to close. Used when the plugin unloads, so a reload does not leave
 * an old ring polling a state directory the next instance also uses. The quit file is
 * removed on a timer; a crash before that only costs the next instance one remove.
 */
function closeOverlay() {
	if (overlayProcess !== null && overlayProcess.exitCode === null) {
		try {
			overlayProcess.kill();
		} catch {
			// Already gone.
		}
	}
	overlayProcess = null;
	try {
		const dir = takeoverDir();
		const quit = join(dir, 'quit.txt');
		writeFileSync(quit, 'quit', 'utf8');
		const timer = setTimeout(() => {
			try { rmSync(quit, { force: true }); } catch { }
		}, 1500);
		if (typeof timer.unref === 'function') timer.unref();
	} catch {
		// Teardown never fails the host.
	}
}

/** Bubble default until the first action label is published. */
const DEFAULT_ACTION_LABEL = '正在准备';

/** Publish the line the overlay's speech bubble shows for the current step. */
function writeTakeoverLabel(dir, label) {
	if (typeof dir !== 'string' || dir.length === 0) return;
	const text = typeof label === 'string' && label.trim().length > 0 ? label.trim() : DEFAULT_ACTION_LABEL;
	try {
		writeFileSync(join(dir, 'action.txt'), text, 'utf8');
	} catch {
		// A missing bubble line is cosmetic; the action still runs.
	}
}

/** One window title or value, shortened so the bubble stays one glance wide. */
function shortLabel(value, max = 20) {
	const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
	if (text.length === 0) return '';
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turn one action into the sentence the character is saying.
 *
 * Kept intentionally concrete: "正在点击「插件」" tells the person what is about to
 * move, while "正在输入文字" deliberately does not echo typed content.
 */
function describeAction(action) {
	const type = action?.action;
	const verbs = {
		click: '正在点击',
		doubleClick: '正在双击',
		rightClick: '正在右键点击',
		middleClick: '正在中键点击',
		move: '正在移动鼠标',
		drag: '正在拖拽',
		scroll: '正在滚动',
		type: '正在输入文字',
		key: '正在按键',
		focus: '正在切换窗口',
		windows: '正在寻找窗口',
		controls: '正在读取窗口控件',
		wait: '正在等待'
	};
	const label = verbs[type] ?? '正在操作';
	if (type === 'type' || type === 'windows' || type === 'wait') return label;
	if (type === 'key') {
		return typeof action?.key === 'string' && action.key.trim().length > 0
			? `${label}（${shortLabel(action.key, 16)}）`
			: label;
	}
	if (Number.isInteger(action?.target)) return `${label}第 ${action.target} 个控件`;
	if (typeof action?.title === 'string' && action.title.trim().length > 0) {
		return `${label}「${shortLabel(action.title, 22)}」`;
	}
	return label;
}

/** One sequence step, with its position when the batch has more than one. */
function describeStep(step, offset, total) {
	const base = describeAction(step);
	return total > 1 ? `第 ${offset + 1}/${total} 步 · ${base}` : base;
}

/**
 * Raise the takeover ring for one action and hand it the token to stamp.
 *
 * The ring is decoration plus one hotkey: it never writes the cursor and never
 * installs an input hook, because either would add exactly the input lag that
 * makes a person's own mouse feel broken while an agent drives. Esc writes the
 * same "stop" the host writes on abort, so the loop stops between two steps.
 *
 * @param cancelPath - the cancel token this action polls.
 * @param config - validated plugin configuration.
 * @param label - what to put in the character's speech bubble.
 * @returns the directory to clear afterwards, or null when the ring is off.
 */
function beginTakeover(cancelPath, config, label) {
	if (config.takeover === false) return null;
	let dir;
	try {
		dir = takeoverDir();
		// A round is a run of actions, not one action. Every new action cancels the
		// pending hide, so the overlay stays up across the click-click-type burst a
		// task really is - and only the last action's two idle seconds take it down.
		if (lingerTimer !== null) {
			clearTimeout(lingerTimer);
			lingerTimer = null;
		}
		writeFileSync(join(dir, 'show.txt'), cancelPath, 'utf8');
		writeTakeoverLabel(dir, label);
	} catch {
		return null;
	}
	if (overlayProcess !== null && overlayProcess.exitCode === null) return dir;
	if (overlayInstanceAlive()) return dir;
	try {
		// A quit marker from the previous instance must not close the process we are
		// about to start.
		rmSync(join(dir, 'quit.txt'), { force: true });
	} catch {
		// The next overlay would see it and exit; the action still runs.
	}
	try {
		overlayProcess = spawn(
			powershellExe(),
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', overlayScript(), '-StateDir', dir],
			{ stdio: 'ignore', windowsHide: true }
		);
		overlayProcess.on('exit', () => {
			overlayProcess = null;
		});
		overlayProcess.on('error', () => {
			overlayProcess = null;
		});
		overlayProcess.unref();
	} catch {
		overlayProcess = null;
	}
	return dir;
}

/** Default linger, used only when the configured value is not a usable number. */
const TAKEOVER_LINGER_MS = 3000;
let lingerTimer = null;
let pendingCancels = [];
let lingeringShowFile = null;

// The linger timer is unref'd so it never holds a host open. A short-lived process - a
// one-shot run, a test harness - can therefore exit before it fires, leaving show.txt
// behind; the overlay lives in its own process and keeps polling, so the ring stays up
// with nobody left to take it down. Remove it synchronously on the way out.
process.once('exit', () => {
	if (lingeringShowFile !== null) {
		try { rmSync(lingeringShowFile, { force: true }); } catch { }
	}
	for (const stale of pendingCancels) {
		try { rmSync(stale, { force: true }); } catch { }
	}
});

/**
 * Schedule the ring to go away. The hide is delayed on purpose: hiding at the end of
 * every action is what made the overlay strobe during a run of small steps, and the
 * cancel file has to outlive the action for the advertised Esc to still mean
 * something while the overlay is up.
 *
 * @param dir - takeover state directory, or null when the ring is off.
 * @param cancelPath - this action's cancel token, if any.
 * @param lingerMs - how long to keep the ring up after this action.
 */
function endTakeover(dir, cancelPath, lingerMs) {
	if (typeof cancelPath === 'string') pendingCancels.push(cancelPath);
	if (dir === null) return;
	if (lingerTimer !== null) clearTimeout(lingerTimer);
	const wait = Number.isFinite(lingerMs) && lingerMs > 0 ? lingerMs : TAKEOVER_LINGER_MS;
	lingeringShowFile = join(dir, 'show.txt');
	lingerTimer = setTimeout(() => {
		lingerTimer = null;
		lingeringShowFile = null;
		try {
			rmSync(join(dir, 'show.txt'), { force: true });
		} catch {
			// The next action rewrites it anyway.
		}
		for (const stale of pendingCancels) {
			try {
				rmSync(stale, { force: true });
			} catch {
				// A leftover cancel file is harmless: the token is unique.
			}
		}
		pendingCancels = [];
	}, wait);
	if (typeof lingerTimer.unref === 'function') lingerTimer.unref();
}

/** True when the person pressed Esc during this action. */
function tookEsc(dir, sinceMs) {
	if (dir === null) return false;
	try {
		return statSync(join(dir, 'esc.txt')).mtimeMs >= sinceMs;
	} catch {
		return false;
	}
}

/**
 * Keep the overlay out of one screenshot.
 *
 * The overlay lives in its own process, so hiding it is a request, not a call: drop
 * `mute.txt` in the state directory and wait for the overlay to answer with
 * `muted.txt`. Without that acknowledgement the frame can be grabbed while the
 * border is still fading out, which shows up as a half-bright edge in the picture.
 *
 * Costs at most MUTE_WAIT_MS, and nothing at all when no overlay is running.
 *
 * @returns an async function that puts the overlay back.
 */
const MUTE_WAIT_MS = 500;
const MUTE_POLL_MS = 8;
/** Let DWM actually drop the hidden window before the frame is grabbed. */
const MUTE_SETTLE_MS = 90;

async function muteOverlayForCapture(config) {
	if (config.takeover === false) return async () => {};
	const dir = takeoverDir();
	const mute = join(dir, 'mute.txt');
	const muted = join(dir, 'muted.txt');
	let acknowledged = false;
	try {
		if (!existsSync(join(dir, 'show.txt'))) return async () => {};
		// A stale acknowledgement from the previous capture would let the frame be
		// grabbed before the overlay has hidden this time.
		rmSync(muted, { force: true });
		writeFileSync(mute, '1', 'utf8');
		const deadline = Date.now() + MUTE_WAIT_MS;
		while (Date.now() < deadline) {
			if (existsSync(muted)) {
				acknowledged = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, MUTE_POLL_MS));
		}
		// Hiding the WPF window answers immediately, but the compositor removes it a
		// frame or two later. A short settle is what keeps a ghost of the ring out of
		// the screenshot.
		if (acknowledged) await new Promise((resolve) => setTimeout(resolve, MUTE_SETTLE_MS));
	} catch {
		return async () => {};
	}
	return async () => {
		try {
			rmSync(mute, { force: true });
		} catch {
			/* the overlay clears muted.txt itself */
		}
	};
}

/**
 * Run one capture: through the warm worker when it is available, otherwise
 * through the one-shot probe.
 *
 * Unlike an action, a capture has no side effects, so any worker failure — a dead
 * worker, a timeout, a protocol surprise — is safe to retry through the fallback.
 *
 * @param params - the capture request.
 * @param config - validated plugin configuration.
 * @param options - signal and timeout.
 * @returns the parsed result.
 */
async function runCapture(params, config, options) {
	// Every capture in the plugin goes through here, so this is the one place the
	// overlay has to step aside - see muteOverlayForCapture.
	const restore = await muteOverlayForCapture(config);
	try {
		if (config.useWorker === false || !actionWorker.usable()) {
			return await runHelper(probeScript(), params, options.signal, options.timeoutMs);
		}
		try {
			return await actionWorker.request({ ...params, kind: 'capture' }, options);
		} catch (error) {
			if (error?.cancelled === true) throw error;
			return runHelper(probeScript(), params, options.signal, options.timeoutMs);
		}
	} finally {
		await restore();
	}
}

/**
 * Resolve (and create) the capture directory for one session.
 *
 * Temp mode is the default, so a project directory never grows a hidden frame
 * folder (and never an untracked one in git). Workspace mode still exists for people
 * who want the files next to their work; it writes a one-line `.gitignore` there so
 * git ignores the whole directory, and falls back to temp if the workspace is not
 * writable.
 *
 * @param exec - tool execution context.
 * @param config - validated plugin configuration.
 * @returns the absolute capture directory.
 */
function captureDir(exec, config) {
	if (config.captureLocation === 'workspace') {
		const cwd = exec.agent?.session.header.cwd;
		if (typeof cwd === 'string' && cwd.length > 0) {
			const dir = join(cwd, CAPTURE_DIRNAME);
			try {
				mkdirSync(dir, { recursive: true });
				try {
					const ignore = join(dir, '.gitignore');
					if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
				} catch {
					// The directory still works without its ignore file.
				}
				return dir;
			} catch {
				// A read-only workspace falls through to temp instead of failing the frame.
			}
		}
	}
	try {
		const dir = tempCaptureDir();
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		const fallback = scratchDir();
		mkdirSync(fallback, { recursive: true });
		return fallback;
	}
}

/**
 * Keep one frame directory inside its count, age, and total-size limits.
 *
 * Attachments are stored content-addressed elsewhere, so pruning a frame never
 * breaks an image the conversation already carries. A limit of 0 disables that
 * particular dimension.
 *
 * @param dir - capture directory.
 * @param config - validated plugin configuration.
 */
function pruneCaptures(dir, config) {
	const retention = config?.captureRetention;
	const maxAgeDays = config?.captureMaxAgeDays;
	const maxTotalMB = config?.captureMaxTotalMB;
	if (!Number.isFinite(retention) && !Number.isFinite(maxAgeDays) && !Number.isFinite(maxTotalMB)) return;
	try {
		const entries = readdirSync(dir)
			.filter((entry) => entry.toLowerCase().endsWith('.png'))
			.map((entry) => {
				const full = join(dir, entry);
				try {
					const info = statSync(full);
					return { full, mtime: info.mtimeMs, bytes: info.size };
				} catch {
					return undefined;
				}
			})
			.filter((entry) => entry !== undefined)
			.sort((left, right) => right.mtime - left.mtime);
		const now = Date.now();
		const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : 0;
		const maxBytes = Number.isFinite(maxTotalMB) && maxTotalMB > 0 ? maxTotalMB * 1024 * 1024 : 0;
		let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
		const kept = [];
		for (const [index, entry] of entries.entries()) {
			const tooOld = maxAgeMs > 0 && now - entry.mtime > maxAgeMs;
			const beyondCount = Number.isFinite(retention) && retention >= 1 && index >= retention;
			if (!tooOld && !beyondCount) {
				kept.push(entry);
				continue;
			}
			try {
				rmSync(entry.full, { force: true });
				total -= entry.bytes;
			} catch {
				// A frame still open in a viewer stays until the next prune.
			}
		}
		if (maxBytes > 0 && total > maxBytes) {
			for (let index = kept.length - 1; index >= 0 && total > maxBytes; index -= 1) {
				const entry = kept[index];
				try {
					rmSync(entry.full, { force: true });
					total -= entry.bytes;
				} catch {
					// Same as above.
				}
			}
		}
	} catch {
		// Pruning is housekeeping and never fails a capture.
	}
}

/** Capture parameters shared by both tools. */
function captureParams(args) {
	const params = { includeCursor: true };
	if (typeof args.screen === 'string' && args.screen.trim().length > 0) params.screen = args.screen.trim();
	if (typeof args.region === 'string' && args.region.trim().length > 0) params.region = args.region.trim();
	if (typeof args.window === 'string' && args.window.trim().length > 0) params.window = args.window.trim();
	if (args.includeCursor === false) params.includeCursor = false;
	return params;
}

/**
 * Perform one capture and, when an attachment store is mounted, commit the
 * frame as an image the conversation can carry.
 * @param ctx - plugin context.
 * @param exec - tool execution context.
 * @param config - validated plugin configuration.
 * @param args - the tool's capture arguments.
 * @returns the structured capture outcome.
 */
async function capture(ctx, exec, config, args) {
	const dir = captureDir(exec, config);
	const file = join(dir, `screen-${nextToken()}.png`);
	const options = optionsFor(exec, config);
	const probe = await runCapture({ ...captureParams(args), rulers: args.rulers ?? config.rulers, out: file }, config, options);
	pruneCaptures(dir, config);

	const result = {
		path: probe.path,
		kind: probe.kind,
		imageWidth: probe.imageWidth,
		imageHeight: probe.imageHeight,
		originX: probe.originX,
		originY: probe.originY,
		scale: probe.scale,
		screens: (probe.screens ?? []).map(screenEntryOf),
		cursor: probe.cursor,
		foregroundWindow: windowInfoOf(probe.foregroundWindow),
		...(probe.capturedAt === undefined ? {} : { capturedAt: probe.capturedAt })
	};

	// Frame deduplication, decided BEFORE the attachment is committed: a picture
	// identical to the one this session already received is not worth another
	// image block (nor a second copy in the store), unless the caller insists.
	const hash = frameHashOf(probe.path);
	if (hash !== undefined) {
		result.frameHash = hash;
		const key = exec?.agent?.session?.header?.sessionId ?? '__global__';
		const previous = lastFrameHashes.get(key);
		lastFrameHashes.set(key, hash);
		if (previous === hash && args.forceImage !== true) {
			result.unchanged = true;
			result.imageSkipped = 'identical to the previous frame of this session, so it was not attached again; pass forceImage: true to see it anyway';
			rememberCaptureIfEmpty(exec, probe);
			return result;
		}
	}

	const attachments = ctx.get('attachments');
	if (attachments === undefined || !config.alwaysSaveFile && args.withImage === false) {
		rememberCaptureIfEmpty(exec, probe);
		return result;
	}

	const limits = attachments.imageLimits;
	const bytes = readFileSync(probe.path);
	if (bytes.byteLength > Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)) {
		result.imageError = `the frame is ${bytes.byteLength} bytes, above this deployment's per-image limit; narrow it with a region or a window capture`;
		rememberCaptureIfEmpty(exec, probe);
		return result;
	}

	try {
		const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: `screen-${nextToken()}.png` });
		result.image = {
			attachmentId: ref.attachmentId,
			mediaType: ref.mediaType,
			bytes: ref.bytes,
			width: ref.width,
			height: ref.height,
			...(ref.name === undefined ? {} : { name: ref.name }),
			...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } })
		};
		// Ask the adapter what size this image will actually have in the request.
		// This is the size the model sees, so imageX/imageY can be resolved without
		// the caller passing preview dimensions by hand.
		const preview = requestPreviewOf(ctx, exec, result.image);
		if (preview !== undefined) {
			result.requestPreview = preview;
			rememberFrame(exec, probe, preview);
		} else {
			rememberFrame(exec, probe, result.image);
		}
	} catch (error) {
		result.imageError = `the frame could not be attached: ${error instanceof Error ? error.message : String(error)}`;
		rememberCaptureIfEmpty(exec, probe);
	}
	return result;
}

/** The exact provider/model route this tool call is running on. */
function routeOf(exec) {
	const routed = exec.agent?.session.requestHeader()?.config;
	return {
		provider: routed?.provider ?? exec.agent?.options.provider,
		model: routed?.model ?? exec.agent?.options.model
	};
}

/**
 * Ask the LLM service for the exact dimensions the provider will receive.
 *
 * The adapter exposes `imageRequestTarget`, the same projection its request
 * serializer uses. That is the size of the image the model actually looks at, so
 * storing it on the frame lets `imageX/imageY` translate without the caller
 * guessing the preview size.
 */
function requestPreviewOf(ctx, exec, image) {
	const { provider, model } = routeOf(exec);
	if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
	const llm = ctx.get('llm');
	if (llm === undefined || typeof llm.imageRequestTarget !== 'function') return undefined;
	const width = Number(image?.width);
	const height = Number(image?.height);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
	try {
		const target = llm.imageRequestTarget(provider, model, {
			width,
			height,
			...(Number.isFinite(Number(image?.bytes)) ? { bytes: Number(image.bytes) } : {}),
			...(typeof image?.mediaType === 'string' ? { mediaType: image.mediaType } : {})
		});
		const targetWidth = Number(target?.width);
		const targetHeight = Number(target?.height);
		if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth <= 0 || targetHeight <= 0) return undefined;
		return { width: targetWidth, height: targetHeight };
	} catch {
		return undefined;
	}
}

/** Enforce the image-input capability gate for the calling route. */
async function assertImageCapableRoute(ctx, exec, what) {
	const { provider, model } = routeOf(exec);
	const llm = ctx.get('llm');
	if (provider === undefined || model === undefined || llm === undefined) {
		throw new Error(`${what} needs an image-capable model route, and the current route could not be resolved; switch to a model that accepts image input`);
	}
	const active = await llm.resolveModelInfo(provider, model, exec.signal);
	if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
		throw new Error(`${what} needs a model that accepts image input, but "${model}" does not declare it; switch models to see the screen`);
	}
}

/** Render one capture as the model-facing envelope plus its image block. */
function captureContent(value) {
	const screens = Array.isArray(value.screens) && value.screens.length > 0
		? value.screens.map((screen) => `${screen.primary ? 'primary ' : ''}${screen.device} ${screen.bounds}`).join('; ')
		: 'unknown';
	const cursor = value.cursor === null || value.cursor === undefined
		? 'unavailable'
		: `${value.cursor.x},${value.cursor.y}`;
	const foreground = value.foregroundWindow === null || value.foregroundWindow === undefined
		? 'none'
		: `"${value.foregroundWindow.title}" (${value.foregroundWindow.process}, class ${value.foregroundWindow.class}) at ${value.foregroundWindow.bounds}`;
	const delivered = value.image;
	const scale = deliveredScale(value);
	const preview = value.requestPreview;
	const previewWidth = Number(preview?.width);
	const previewHeight = Number(preview?.height);
	const hasPreview = Number.isInteger(previewWidth) && previewWidth > 0 && Number.isInteger(previewHeight) && previewHeight > 0;
	// The request image is what the model actually looks at. State that size first,
	// because imageX/imageY are read in it.
	const sizeLine = hasPreview
		? `<image_size delivered="${delivered === undefined ? 'none' : `${delivered.width}x${delivered.height}`}" request_preview="${previewWidth}x${previewHeight}">${previewWidth}x${previewHeight}</image_size>`
		: (delivered === undefined
			? `<image_size delivered="none" captured="${value.imageWidth}x${value.imageHeight}">${value.imageWidth}x${value.imageHeight}</image_size>`
			: (scaleIsOne(scale)
				? `<image_size>${delivered.width}x${delivered.height}</image_size>`
				: `<image_size delivered="${delivered.width}x${delivered.height}" captured="${value.imageWidth}x${value.imageHeight}">${delivered.width}x${delivered.height}</image_size>`));
	const mapWidth = hasPreview ? previewWidth : (delivered?.width ?? value.imageWidth);
	const mapHeight = hasPreview ? previewHeight : (delivered?.height ?? value.imageHeight);
	const lines = [
		'<screen_capture>',
		`<kind>${value.kind}</kind>`,
		sizeLine,
		`<physical_origin>${value.originX},${value.originY}</physical_origin>`,
		`<click_map>imageX/imageY are read in the request image (${mapWidth}x${mapHeight}; origin ${value.originX},${value.originY}); the plugin maps them to screen pixels. imageWidth/imageHeight are only needed if your copy differs from this size.</click_map>`,
		`<scale>${value.scale}</scale>`,
		`<screens>${screens}</screens>`,
		`<cursor>${cursor}</cursor>`,
		`<foreground_window>${foreground}</foreground_window>`,
		`<file>${value.path}</file>`
	];
	if (!scaleIsOne(scale)) {
		lines.push(`<delivered_scale>${deliveredScaleNote(delivered, scale)}</delivered_scale>`);
	}
	if (value.rulers === true) {
		lines.push('<rulers>ticks along the top and left edge, labelled with screen coordinates, so you can read a position without counting pixels</rulers>');
	}
	if (value.imageError !== undefined) lines.push(`<image_error>${value.imageError}</image_error>`);
	if (value.imageSkipped !== undefined) lines.push(`<image_skipped>${value.imageSkipped}</image_skipped>`);
	lines.push('</screen_capture>');
	if (delivered !== undefined) lines.push(coordinateContract(value));
	else if (value.unchanged === true) lines.push('Nothing changed since the last frame of this session, so the image you already have still applies — including its coordinates.');
	const blocks = [{ type: 'text', text: lines.join('\n') }];
	if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image });
	return blocks;
}

/**
 * The pixel-space contract, restated next to every frame the model receives.
 *
 * It has to be conditional, because the attachment store may deliver a frame
 * smaller than the capture (it re-encodes within its own byte limits). A model that
 * reads a coordinate off a shrunk image and passes it through unchanged clicks the
 * wrong place, so when the two sizes differ this says the ratio out loud instead of
 * claiming 1:1.
 *
 * @param value - a capture, or a tool result carrying one under `capture`.
 * @returns the contract text for that frame.
 */
function coordinateContract(value) {
	const capture = value?.capture ?? value;
	const width = Number(capture?.imageWidth);
	const height = Number(capture?.imageHeight);
	const sizeKnown = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
	const frame = sizeKnown ? `${width}x${height}` : 'the captured frame';
	const scale = deliveredScale(capture);
	const storeShrank = !scaleIsOne(scale);
	const preview = capture?.requestPreview;
	const previewWidth = Number(preview?.width);
	const previewHeight = Number(preview?.height);
	const hasPreview = Number.isInteger(previewWidth) && previewWidth > 0 && Number.isInteger(previewHeight) && previewHeight > 0;
	// The adapter's imageRequestTarget is the exact request image, so imageX/imageY
	// has a trustworthy default size. No guessing about the pipeline budget.
	const lines = [
		`Image pixel (0,0) is the top-left of this frame, which was captured at ${frame} physical screen pixels; both halves of this device are per-monitor DPI aware.`
	];
	if (storeShrank) {
		lines.push(axesAgree(scale)
			? `The attachment store already delivered it at ${printed((scale.x + scale.y) / 2)}x that.`
			: `The attachment store already delivered it at ${printed(scale.x)}x horizontally and ${printed(scale.y)}x vertically.`);
	}
	lines.push(hasPreview
		? `The request image is ${previewWidth}x${previewHeight}; imageX/imageY are read in that space and the plugin maps them to screen pixels.`
		: 'The request pipeline may resize this frame; if the image you see differs in size, pass imageWidth/imageHeight with imageX/imageY.');
	lines.push('For clicks, prefer imageX/imageY: the plugin adds the frame origin and scales through the request image. imageWidth/imageHeight are only needed if your copy differs from the size above.');
	lines.push(sizeKnown
		? (hasPreview
			? `If you use physical x/y instead, multiply every image reading by ${width} / ${previewWidth} (and ${height} / ${previewHeight}) before passing it; ruler labels, when drawn, are already screen coordinates.`
			: `If you use physical x/y instead, multiply every image reading by ${width} / the width of the image you see (and ${height} / its height) before passing it; ruler labels, when drawn, are already screen coordinates.`)
		: 'If you use physical x/y instead, scale image readings to the captured frame first.');
	return lines.join(' ');
}

/**
 * How the delivered image relates to the captured frame.
 * @param value - the capture outcome.
 * @returns per-axis delivered/captured ratios, or undefined when there is no frame.
 */
function deliveredScale(value) {
	const delivered = value?.image;
	if (delivered === undefined || delivered === null) return undefined;
	const capturedWidth = Number(value.imageWidth);
	const capturedHeight = Number(value.imageHeight);
	const deliveredWidth = Number(delivered.width);
	const deliveredHeight = Number(delivered.height);
	if (!Number.isFinite(capturedWidth) || !Number.isFinite(capturedHeight) || capturedWidth <= 0 || capturedHeight <= 0) return undefined;
	if (!Number.isFinite(deliveredWidth) || !Number.isFinite(deliveredHeight) || deliveredWidth <= 0 || deliveredHeight <= 0) return undefined;
	const closeToOne = (ratio) => Math.abs(ratio - 1) < 0.002;
	const x = deliveredWidth / capturedWidth;
	const y = deliveredHeight / capturedHeight;
	return { x: closeToOne(x) ? 1 : x, y: closeToOne(y) ? 1 : y };
}

/** True when the delivered frame is exactly the capture. */
function scaleIsOne(scale) {
	return scale === undefined || (scale.x === 1 && scale.y === 1);
}

const axesAgree = (scale) => Math.abs(scale.x - scale.y) <= 0.005 * Math.max(scale.x, scale.y);
const printed = (value) => Number(value.toFixed(4));

/**
 * One line stating what the delivered frame is worth, in the shape the model can
 * act on: the ratio, and the multiplier to apply to a reading.
 * @param delivered - the attached image value.
 * @param scale - per-axis delivered/captured ratios.
 * @returns the sentence for the envelope.
 */
function deliveredScaleNote(delivered, scale) {
	if (axesAgree(scale)) {
		const ratio = (scale.x + scale.y) / 2;
		return `delivered ${delivered.width}x${delivered.height} = ${printed(ratio)}x capture; multiply image readings by ${printed(1 / ratio)} to get screen pixels`;
	}
	return `delivered ${delivered.width}x${delivered.height} = ${printed(scale.x)}x horizontally, ${printed(scale.y)}x vertically of the capture; multiply image readings by ${printed(1 / scale.x)}, ${printed(1 / scale.y)} to get screen pixels`;
}

/** Render one control outcome. */
function controlText(value) {
	const cursor = value.cursor === null || value.cursor === undefined ? 'unknown' : `${value.cursor.x},${value.cursor.y}`;
	const lines = [
		'<desktop_action>',
		`<action>${value.action}</action>`,
		`<cursor>${cursor}</cursor>`,
		`<foreground>${value.foregroundTitle ?? 'unknown'}${value.foregroundProcess === undefined || value.foregroundProcess === null ? '' : ` (${value.foregroundProcess})`}</foreground>`
	];
	if (Array.isArray(value.notes)) for (const note of value.notes) lines.push(`<note>${note}</note>`);
	if (typeof value.controlsWindow === 'string') lines.push(`<controls_window>${value.controlsWindow}</controls_window>`);
	if (typeof value.controlCount === 'number') lines.push(`<control_count>${value.controlCount}</control_count>`);
	// How much the meaningfulOnly filter looked at and threw away. Without these an
	// empty list is indistinguishable from a window that really has no controls.
	if (typeof value.controlTotal === 'number') lines.push(`<control_total>${value.controlTotal}</control_total>`);
	if (typeof value.filteredOut === 'number' && value.filteredOut > 0) lines.push(`<filtered_out>${value.filteredOut}</filtered_out>`);
	if (Array.isArray(value.controls) && value.controls.length > 0) {
		lines.push('<controls>');
		for (const control of value.controls) lines.push(String(control));
		lines.push('</controls>');
	}
	if (value.controlsTruncated === true) lines.push('<controls_truncated>true</controls_truncated>');
	if (Array.isArray(value.windows) && value.windows.length > 0) {
		lines.push('<windows>');
		for (const w of value.windows) {
			const flags = [w.foreground === true ? 'foreground' : '', w.minimized === true ? 'minimized' : ''].filter(Boolean).join(',');
			lines.push(`${w.handle ?? '?'} '${w.title ?? ''}' (${w.process ?? '?'}) @ ${w.bounds ?? '?'}${flags === '' ? '' : ` [${flags}]`}`);
		}
		lines.push('</windows>');
	}
	if (typeof value.windowCount === 'number' && !Array.isArray(value.windows)) lines.push(`<window_count>${value.windowCount}</window_count>`);
	if (typeof value.capturePath === 'string') lines.push(`<capture_file>${value.capturePath}</capture_file>`);
	if (typeof value.captureError === 'string') lines.push(`<capture_error>${value.captureError}</capture_error>`);
	lines.push('</desktop_action>');
	if (value.capture !== null && value.capture !== undefined) lines.push(coordinateContract(value.capture));
	return lines.join('\n');
}

const IMAGE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		attachmentId: { type: 'string', required: true },
		mediaType: { type: 'string', required: true },
		bytes: { type: 'integer', required: true },
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
		name: { type: 'string' },
		originalDimensions: {
			type: 'object',
			additionalProperties: false,
			properties: {
				width: { type: 'integer', required: true },
				height: { type: 'integer', required: true }
			}
		}
	}
};

const SCREEN_INFO_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		device: { type: 'string', required: true },
		primary: { type: 'boolean', required: true },
		bounds: { type: 'string', required: true }
	}
};

const WINDOW_INFO_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		handle: { type: 'string' },
		title: { type: 'string' },
		class: { type: 'string' },
		process: { type: 'string' },
		pid: { type: 'integer' },
		bounds: { type: 'string' },
		visible: { type: 'boolean' },
		minimized: { type: 'boolean' },
		foreground: { type: 'boolean' }
	}
};

/**
 * Copy the screen-inventory entry field by field. The sensor's own bookkeeping
 * keys must never reach a closed output schema: a result carrying an undeclared
 * key is rejected by the runtime *after* the side effect has already happened.
 * @param screen - one entry from the sensor's `screens` array.
 * @returns the declared projection.
 */
function screenEntryOf(screen) {
	return { device: screen.device, primary: screen.primary, bounds: screen.bounds };
}

/**
 * Drop absent-valued properties, recursively: `undefined` anywhere, and `null` as
 * an object property.
 *
 * The runtime validates a tool result as lossless JSON and against the declared
 * output schema, and when either fails it refuses the whole call *after* the body
 * has already run against the real desktop. One property is enough, and this is
 * one mistake wearing five hats: a window entry carrying `visible`, a projection
 * emitting `{ path: undefined }`, a window entry carrying `class` when the
 * enumeration script never reported one, and `foregroundProcess: null` — the
 * process-name helper returns `$null` when it cannot resolve one, and the
 * validator rejects null for a declared `string` exactly as it rejects undefined.
 * Projections are written by hand and will keep forgetting, so results are pruned
 * once at the boundary rather than trusted field by field.
 *
 * A `null` *array item* is kept: JSON itself uses null for a hole, so it is
 * lossless, and dropping it would renumber the array.
 * @param value - any JSON-shaped value.
 * @returns the same shape, with absent-valued object properties removed.
 */
function pruneAbsent(value) {
	// An array hole is not JSON either: the runtime walks array items the same way it
	// walks properties, so `[1, undefined]` is refused. `null` is what JSON itself
	// substitutes for a hole, so that is what the hole becomes here.
	if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : pruneAbsent(entry)));
	if (value === null || typeof value !== 'object') return value;
	const pruned = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined || entry === null) continue;
		pruned[key] = pruneAbsent(entry);
	}
	return pruned;
}

/**
 * Copy a window entry field by field, dropping the sensor's undeclared keys.
 *
 * Every field a window entry may carry has to be listed here *and* in
 * WINDOW_INFO_SCHEMA: the schema is closed, so a field the sensor reports but
 * neither declares nor projects is rejected by the runtime after the action has
 * already happened. `visible` shipped that way — the sensor reports it, the
 * schema did not declare it, and the `windows` action was refused outright.
 *
 * A field the sensor does *not* report is the mirror image of the same mistake:
 * `class` is reported by the capture path but not by the window enumeration, so
 * writing it unconditionally put `class: undefined` into every listed entry. Each
 * optional field is therefore spread in only when it has a value.
 * @param window - a sensor window entry, or undefined.
 * @returns the declared projection, or undefined when there was no window.
 */
function windowInfoOf(window) {
	if (window === null || window === undefined) return undefined;
	return {
		handle: window.handle,
		title: window.title,
		...(window.class === undefined ? {} : { class: window.class }),
		process: window.process,
		pid: window.pid,
		bounds: window.bounds,
		...(window.visible === undefined ? {} : { visible: window.visible }),
		...(window.minimized === undefined ? {} : { minimized: window.minimized }),
		...(window.foreground === undefined ? {} : { foreground: window.foreground })
	};
}

/** Area of a window's `x,y,width,height` bounds string, or 0 when unreadable. */
function boundsArea(bounds) {
	if (typeof bounds !== 'string') return 0;
	const parts = bounds.split(',').map((part) => Number(part.trim()));
	if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return 0;
	return Math.max(0, parts[2]) * Math.max(0, parts[3]);
}

/** Where the request pipeline is predicted to put a frame, and the budget used. */
const REQUEST_PREVIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
		maxPixels: { type: 'number' }
	}
};

const CAPTURE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		path: { type: 'string', required: true },
		kind: { type: 'string', required: true },
		imageWidth: { type: 'integer', required: true },
		imageHeight: { type: 'integer', required: true },
		originX: { type: 'integer', required: true },
		originY: { type: 'integer', required: true },
		scale: { type: 'number', required: true },
		screens: { type: 'array', required: true, items: SCREEN_INFO_SCHEMA },
		cursor: {
			type: 'object',
			additionalProperties: false,
			properties: {
				x: { type: 'integer', required: true },
				y: { type: 'integer', required: true },
				screen: { type: 'string' }
			}
		},
		foregroundWindow: WINDOW_INFO_SCHEMA,
		image: IMAGE_VALUE_SCHEMA,
		imageError: { type: 'string' },
		imageSkipped: { type: 'string' },
		frameHash: { type: 'string' },
		unchanged: { type: 'boolean' },
		rulers: { type: 'boolean' },
		requestPreview: REQUEST_PREVIEW_SCHEMA,
		capturedAt: { type: 'string' }
	}
};

/** Cursor projection shared by the capture and control schemas. */
const CURSOR_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		x: { type: 'integer', required: true },
		y: { type: 'integer', required: true },
		screen: { type: 'string' }
	}
};

/** Actions a sequence step may name. `wait` is served in this process. */
const SEQUENCE_ACTIONS = ['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'drag', 'scroll', 'type', 'key', 'focus', 'wait'];
/** Actions whose x/y are mandatory. */
const POINTER_ACTIONS = new Set(['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'scroll']);
/** The risk ladder the batch gate enforces. */
const RISKS = ['low', 'medium', 'high'];
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
/** Step fields forwarded verbatim to the action helper. */
const STEP_FIELDS = ['x', 'y', 'toX', 'toY', 'amount', 'text', 'key', 'title', 'hwnd', 'button', 'tolerant', 'target', 'includeValues', 'meaningfulOnly'];

const SEQUENCE_STEP_RESULT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		index: { type: 'integer', required: true },
		action: { type: 'string', required: true },
		ok: { type: 'boolean', required: true },
		ms: { type: 'integer', required: true },
		cursor: CURSOR_SCHEMA,
		foregroundTitle: { type: 'string' },
		note: { type: 'string' },
		risk: { type: 'string' }
	}
};

const SEQUENCE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		risk: { type: 'string', required: true },
		confirmed: { type: 'boolean', required: true },
		planned: { type: 'boolean' },
		stepCount: { type: 'integer', required: true },
		executed: { type: 'integer', required: true },
		failed: { type: 'integer', required: true },
		steps: { type: 'array', required: true, items: SEQUENCE_STEP_RESULT_SCHEMA },
		cursor: CURSOR_SCHEMA,
		foregroundTitle: { type: 'string' },
		foregroundProcess: { type: 'string' },
		capture: CAPTURE_SCHEMA,
		capturePath: { type: 'string' },
		captureError: { type: 'string' },
		frameHash: { type: 'string' },
		unchanged: { type: 'boolean' },
		imageSkipped: { type: 'string' },
		notes: { type: 'array', items: { type: 'string' } },
		actedAt: { type: 'string' }
	}
};

/**
 * Validate and normalize one batch of steps. A step is a desktop_control action
 * without its own screenshot, plus optional per-step `settleMs`, `risk` and
 * `riskNote`; the `wait` action takes `ms` instead.
 *
 * This runs before anything touches the desktop, so a malformed batch costs one
 * round trip instead of half a gesture.
 *
 * @param args - the tool arguments.
 * @param config - validated plugin configuration (for the step cap).
 * @returns the normalized steps.
 */
function normalizeSequence(args, config) {
	const raw = Array.isArray(args?.steps) ? args.steps : [];
	if (raw.length === 0) throw new Error('desktop_sequence needs at least one step');
	if (raw.length > config.maxSequenceSteps) {
		throw new Error(`desktop_sequence accepts at most ${config.maxSequenceSteps} steps (got ${raw.length}); split the batch or raise maxSequenceSteps`);
	}
	return raw.map((step, offset) => {
		const position = offset + 1;
		if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new Error(`step ${position} must be an object`);
		const action = step.action;
		if (typeof action !== 'string' || !SEQUENCE_ACTIONS.includes(action)) {
			throw new Error(`step ${position} has an unknown action ${JSON.stringify(action)}; use ${SEQUENCE_ACTIONS.join('/')}`);
		}
		const normalized = { action };
		for (const field of [...STEP_FIELDS, 'ms', 'risk', 'riskNote']) {
			if (step[field] !== undefined && step[field] !== null) normalized[field] = step[field];
		}
		if (POINTER_ACTIONS.has(action) && (!Number.isInteger(normalized.x) || !Number.isInteger(normalized.y))) {
			throw new Error(`step ${position} (${action}) needs integer x and y`);
		}
		if (action === 'drag' && (!Number.isInteger(normalized.toX) || !Number.isInteger(normalized.toY))) {
			throw new Error(`step ${position} (drag) needs integer toX and toY`);
		}
		if (action === 'type' && typeof normalized.text !== 'string') throw new Error(`step ${position} (type) needs text`);
		if (action === 'key' && typeof normalized.key !== 'string') throw new Error(`step ${position} (key) needs key`);
		if (action === 'focus' && typeof normalized.title !== 'string' && typeof normalized.hwnd !== 'string') {
			throw new Error(`step ${position} (focus) needs a title, or an hwnd`);
		}
		if (action === 'wait' && !Number.isInteger(normalized.ms)) throw new Error(`step ${position} (wait) needs integer ms`);
		if (normalized.risk !== undefined && !RISKS.includes(normalized.risk)) {
			throw new Error(`step ${position} risk must be one of ${RISKS.join('/')}`);
		}
		return normalized;
	});
}

/** Modifier spellings the helper accepts, normalized to one name. */
const MODIFIER_NAMES = new Map([
	['ctrl', 'ctrl'],
	['control', 'ctrl'],
	['alt', 'alt'],
	['shift', 'shift'],
	['win', 'win'],
	['windows', 'win'],
	['cmd', 'win'],
	['meta', 'win']
]);

/** Shortcuts that reach a system surface or destroy data in one press. */
const DANGEROUS_CHORDS = [
	{ mods: ['win'], base: 'r', why: '打开「运行」对话框' },
	{ mods: ['ctrl', 'shift'], base: 'esc', why: '打开任务管理器' },
	{ mods: ['alt'], base: 'f4', why: '直接关闭当前窗口' },
	{ mods: ['shift'], base: 'delete', why: '永久删除、不进回收站' }
];

/** Window title fragments that mean the action is aimed at a UAC prompt. */
const UAC_TITLES = ['用户帐户控制', '用户账户控制', 'user account control'];

/** Normalize a key spelling so esc/escape and del/delete compare equal. */
function normalizeKeyName(name) {
	const lower = name.toLowerCase();
	if (lower === 'escape') return 'esc';
	if (lower === 'del') return 'delete';
	return lower;
}

/** Split a chord such as `ctrl+shift+esc` into its modifiers and one base key. */
function keyChord(spec) {
	if (typeof spec !== 'string') return undefined;
	const parts = spec.split('+').map((part) => part.trim()).filter((part) => part.length > 0);
	const mods = [];
	let base;
	for (const part of parts) {
		const modifier = MODIFIER_NAMES.get(part.toLowerCase());
		if (modifier !== undefined) {
			if (!mods.includes(modifier)) mods.push(modifier);
			continue;
		}
		if (base !== undefined) return undefined;
		base = normalizeKeyName(part);
	}
	return base === undefined ? undefined : { mods: mods.sort(), base };
}

/**
 * Hard-coded danger check: the model cannot talk the guard off a single call.
 *
 * The original plugin trusted the caller's self-declared risk. A shortcut like win+r
 * could therefore be labelled low and run; this one forces an explicit confirm flag
 * on the dangerous chords and on a focus aimed at a UAC prompt.
 *
 * @param action - a desktop_control argument object or one normalized sequence step.
 * @returns a human reason when the step is dangerous, otherwise undefined.
 */
function hazardOf(action) {
	if (action === null || typeof action !== 'object') return undefined;
	if (action.action === 'key') {
		const chord = keyChord(action.key);
		if (chord === undefined) return undefined;
		for (const entry of DANGEROUS_CHORDS) {
			if (chord.base !== entry.base || chord.mods.length !== entry.mods.length) continue;
			if (chord.mods.every((modifier, index) => modifier === entry.mods[index])) {
				return `${action.key} 会${entry.why}`;
			}
		}
		return undefined;
	}
	if (action.action === 'focus' && typeof action.title === 'string') {
		const title = action.title.toLowerCase();
		if (UAC_TITLES.some((needle) => title.includes(needle.toLowerCase()))) {
			return '焦点落在用户帐户控制（UAC）窗口上，随手一点就可能授权提权';
		}
	}
	return undefined;
}

/** Refuse one dangerous call unless the caller explicitly confirmed it. */
function assertActionAllowed(action, config) {
	if (config.guardDangerous !== true) return undefined;
	const reason = hazardOf(action);
	if (reason === undefined) return undefined;
	if (action.confirm === true) return reason;
	throw new Error(
		`desktop_control 在碰桌面之前停下了：${reason}。危险操作守卫要求先把这件事告诉用户；用户同意后，` +
		'用同一个调用加上 confirm: true 再来。'
	);
}

/**
 * Apply the risk gate: the model declares risk, the tool enforces it. Low risk
 * batches freely; medium/high is refused before anything is executed unless the
 * caller passes `confirm: true` (which it does only after the user agreed).
 *
 * Dangerous chords are raised to high internally, whatever the step declared, so a
 * `risk: 'low'` note can never route around the guard.
 *
 * @param steps - normalized steps.
 * @param declared - the batch-level risk the model declared.
 * @param confirm - the caller's explicit approval flag.
 * @param config - validated plugin configuration.
 * @returns the effective risk level.
 */
function sequenceRisk(steps, declared, confirm, config) {
	let effective = RISKS.includes(declared) ? declared : 'low';
	const flagged = [];
	for (const [offset, step] of steps.entries()) {
		const hazard = config.guardDangerous === true ? hazardOf(step) : undefined;
		const stepRisk = hazard === undefined ? (step.risk ?? 'low') : 'high';
		if (RISK_ORDER[stepRisk] > 0) {
			const why = hazard ?? (typeof step.riskNote === 'string' && step.riskNote.length > 0 ? step.riskNote : '');
			flagged.push(`#${offset + 1} ${step.action}${why === '' ? '' : `（${why}）`}`);
		}
		if (RISK_ORDER[stepRisk] > RISK_ORDER[effective]) effective = stepRisk;
	}
	if (RISK_ORDER[effective] > 0 && confirm !== true) {
		const parts = flagged.length > 0 ? flagged.join('，') : '整批操作';
		throw new Error(
			`desktop_sequence 在碰桌面之前停下了：这一批被判定为 ${effective} 风险（${parts}）。` +
			'先把要做什么告诉用户；用户同意后，用同样的步骤加上 confirm: true 再来——或者把危险的那一步单独跑，方便单独审阅。'
		);
	}
	return effective;
}

/** True when the cancel token was stamped. */
function stopRequested(cancelPath) {
	if (typeof cancelPath !== 'string' || cancelPath.length === 0) return false;
	try {
		return readFileSync(cancelPath, 'utf8').trim() === 'stop';
	} catch {
		return false;
	}
}

/**
 * A wait that still honours an interrupted turn AND the person pressing Esc.
 * A plain timer would sit through a 900 ms settle after the takeover was already
 * called off, which is the one moment the ring most obviously lies.
 */
function abortableWait(ms, signal, cancelPath) {
	return new Promise((resolvePromise, rejectPromise) => {
		let timer;
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn(value);
		};
		const deadline = Date.now() + Math.max(0, ms);
		const tick = () => {
			if (signal?.aborted) {
				finish(rejectPromise, new Error('see-touch: the batch was cancelled during a wait'));
				return;
			}
			if (stopRequested(cancelPath)) {
				finish(rejectPromise, Object.assign(new Error('see-touch: the person pressed Esc and cancelled this batch'), { cancelled: true }));
				return;
			}
			const left = deadline - Date.now();
			if (left <= 0) {
				finish(resolvePromise);
				return;
			}
			timer = setTimeout(tick, Math.min(100, left));
		};
		// Settle here instead of only clearing the timer. Clearing the timer was the
		// only thing this listener did, and the next tick was the only thing that
		// could ever settle the promise - so an abort left it pending for the rest of
		// the session and the caller waited on a wait that had already been called off.
		const onAbort = () => {
			finish(rejectPromise, Object.assign(new Error('see-touch: the batch was cancelled during a wait'), { cancelled: true }));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		tick();
	});
}

/** Run one step: `wait` locally, everything else through the action helper. */
async function runSequenceStep(step, config, options, cancelPath, label) {
	const started = Date.now();
	if (step.action === 'wait') {
		await abortableWait(step.ms, options.signal, cancelPath);
		return { action: 'wait', ok: true, ms: Date.now() - started };
	}
	const params = { action: step.action, settleMs: Number.isSafeInteger(step.settleMs) ? step.settleMs : config.stepSettleMs };
	for (const field of STEP_FIELDS) if (step[field] !== undefined) params[field] = step[field];
	const acted = await runAction(params, config, options, cancelPath, label);
	const entry = { action: step.action, ok: true, ms: Date.now() - started };
	if (acted.cursor !== undefined) entry.cursor = acted.cursor;
	if (acted.foregroundTitle !== undefined) entry.foregroundTitle = acted.foregroundTitle;
	if (Array.isArray(acted.notes) && acted.notes.length > 0) entry.note = acted.notes.join('; ');
	return entry;
}

/** Content hash of one saved frame: identifies a screen that did not change. */
function frameHashOf(file) {
	try {
		return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
	} catch {
		return undefined;
	}
}

/** Last frame hash per session, so an identical frame can be recognised. */
const lastFrameHashes = new Map();

/**
 * Last frame geometry per session, so `imageX/imageY` can be translated back to
 * physical screen pixels without the caller doing origin/scale arithmetic.
 */
const lastFrames = new Map();

/** Stable key for the session a tool call belongs to. */
function frameKey(exec) {
	return exec?.agent?.session?.header?.sessionId ?? '__global__';
}

/** Remember where the frame came from and how large the model's copy is. */
function rememberFrame(exec, probe, image) {
	if (probe === null || probe === undefined) return;
	const width = Number(probe.imageWidth);
	const height = Number(probe.imageHeight);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
	const deliveredWidth = Number(image?.width);
	const deliveredHeight = Number(image?.height);
	lastFrames.set(frameKey(exec), {
		originX: Number(probe.originX) || 0,
		originY: Number(probe.originY) || 0,
		width,
		height,
		deliveredWidth: Number.isFinite(deliveredWidth) && deliveredWidth > 0 ? deliveredWidth : width,
		deliveredHeight: Number.isFinite(deliveredHeight) && deliveredHeight > 0 ? deliveredHeight : height,
		at: Date.now()
	});
}

/** Keep the previous image mapping when this capture attached no new image. */
function rememberCaptureIfEmpty(exec, probe) {
	if (lastFrames.has(frameKey(exec))) return;
	rememberFrame(exec, probe);
}

/** Actions that accept coordinates read off a frame. */
const IMAGE_ACTIONS = new Set(['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'drag', 'scroll']);

/**
 * Translate coordinates read off the model's image into physical screen pixels.
 *
 * The image the caller sees is usually the attachment store's copy, sometimes smaller
 * than the captured frame and sometimes smaller again after the request pipeline. The
 * frame origin and the image-to-capture ratio are exactly what a human would otherwise
 * have to add by hand, and exactly where most misclicks come from.
 *
 * @param exec - tool execution context (identifies the session's last frame).
 * @param action - a desktop_control argument object or one normalized sequence step.
 * @returns the translated start/end points, or undefined when no image coordinates were used.
 */
function translateImageCoords(exec, action) {
	const hasStart = action.imageX !== undefined || action.imageY !== undefined;
	const hasEnd = action.imageToX !== undefined || action.imageToY !== undefined;
	const hasSize = action.imageWidth !== undefined || action.imageHeight !== undefined;
	if (!hasStart && !hasEnd) {
		if (hasSize) throw new Error('imageWidth/imageHeight 只能和 imageX/imageY 一起用');
		return undefined;
	}
	if (!IMAGE_ACTIONS.has(action.action)) {
		throw new Error('imageX/imageY 只用于指针动作（click、move、drag、scroll 等）');
	}
	if (action.target !== undefined) throw new Error('target 和 imageX/imageY 只能选一组');
	if (action.x !== undefined || action.y !== undefined) throw new Error('x/y 和 imageX/imageY 只能选一组');
	if ((action.imageWidth === undefined) !== (action.imageHeight === undefined)) {
		throw new Error('imageWidth 和 imageHeight 要一起给');
	}
	const frame = lastFrames.get(frameKey(exec));
	if (frame === undefined) {
		throw new Error('还没有可用的截图帧：先调用 screen_view（或带 capture 的 desktop_control）再按 imageX/imageY 点。');
	}
	const previewW = Number(action.imageWidth ?? frame.deliveredWidth);
	const previewH = Number(action.imageHeight ?? frame.deliveredHeight);
	if (!Number.isFinite(previewW) || !Number.isFinite(previewH) || previewW <= 0 || previewH <= 0) {
		throw new Error('截图帧的预览尺寸不可用；请重新 screen_view 后带上 imageWidth/imageHeight 再试。');
	}
	const point = (ix, iy, label) => {
		if (!Number.isInteger(ix) || !Number.isInteger(iy)) throw new Error(`${label} 必须是整数`);
		if (ix < 0 || iy < 0 || ix >= previewW || iy >= previewH) {
			throw new Error(`${label} 超出这张图的 ${previewW}x${previewH} 范围（坐标从 0 开始）`);
		}
		return {
			x: Math.round(frame.originX + ix * (frame.width / previewW)),
			y: Math.round(frame.originY + iy * (frame.height / previewH))
		};
	};
	const start = hasStart ? point(action.imageX, action.imageY, 'imageX/imageY') : undefined;
	const end = hasEnd ? point(action.imageToX, action.imageToY, 'imageToX/imageToY') : undefined;
	if (action.action === 'drag') {
		if (start === undefined || end === undefined) {
			throw new Error('drag 用截图坐标时，imageX/imageY 和 imageToX/imageToY 都要给');
		}
	} else if (end !== undefined) {
		throw new Error('只有 drag 使用 imageToX/imageToY');
	}
	return { start, end, previewWidth: previewW, previewHeight: previewH };
}

/** Translate image coordinates in a batch before its steps are validated. */
function translateSequenceSteps(exec, steps) {
	if (!Array.isArray(steps)) return steps;
	return steps.map((step) => {
		if (step === null || typeof step !== 'object' || Array.isArray(step)) return step;
		const usesImage = step.imageX !== undefined || step.imageY !== undefined
			|| step.imageToX !== undefined || step.imageToY !== undefined
			|| step.imageWidth !== undefined || step.imageHeight !== undefined;
		if (!usesImage) return step;
		const translated = translateImageCoords(exec, step);
		if (translated === undefined) return step;
		const next = { ...step };
		if (translated.start !== undefined) {
			next.x = translated.start.x;
			next.y = translated.start.y;
		}
		if (translated.end !== undefined) {
			next.toX = translated.end.x;
			next.toY = translated.end.y;
		}
		delete next.imageX;
		delete next.imageY;
		delete next.imageToX;
		delete next.imageToY;
		delete next.imageWidth;
		delete next.imageHeight;
		return next;
	});
}

/** Render one batch outcome: a compact per-step ledger, then the end frame. */
function sequenceText(value) {
	const flags = `${value.risk}${value.confirmed === true ? ', confirmed' : ''}${value.planned === true ? ', dry run' : ''}`;
	const lines = [
		'<desktop_sequence>',
		`<risk>${flags}</risk>`,
		`<steps>${value.executed}/${value.stepCount} executed${value.failed > 0 ? `, ${value.failed} failed` : ''}</steps>`
	];
	for (const step of value.steps ?? []) {
		lines.push(`<step n="${step.index}" action="${step.action}" ok="${step.ok}" ms="${step.ms}">${step.note === undefined ? '' : step.note}</step>`);
	}
	if (value.foregroundTitle !== undefined) {
		lines.push(`<foreground>${value.foregroundTitle}${value.foregroundProcess === undefined || value.foregroundProcess === null ? '' : ` (${value.foregroundProcess})`}</foreground>`);
	}
	if (value.cursor !== undefined && value.cursor !== null) lines.push(`<cursor>${value.cursor.x},${value.cursor.y}</cursor>`);
	if (typeof value.capturePath === 'string') lines.push(`<capture_file>${value.capturePath}</capture_file>`);
	if (typeof value.frameHash === 'string') lines.push(`<frame_hash>${value.frameHash}${value.unchanged === true ? ' (unchanged)' : ''}</frame_hash>`);
	if (typeof value.imageSkipped === 'string') lines.push(`<image_skipped>${value.imageSkipped}</image_skipped>`);
	if (typeof value.captureError === 'string') lines.push(`<capture_error>${value.captureError}</capture_error>`);
	for (const note of value.notes ?? []) lines.push(`<note>${note}</note>`);
	lines.push('</desktop_sequence>');
	if (value.capture !== undefined && value.capture !== null) lines.push(coordinateContract(value.capture));
	const blocks = [{ type: 'text', text: lines.join('\n') }];
	const image = value.capture === undefined || value.capture === null ? undefined : value.capture.image;
	if (image !== undefined) blocks.push({ type: 'image', attachment: image });
	return blocks;
}

/**
 * Register `screen_view`, `desktop_control` and `desktop_sequence`.
 * @param ctx - the plugin context owning the tool registry.
 * @param rawConfig - the profile row's configuration, validated here.
 */
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	shellRuntime = resolveShell(config.shell);
	cleanupStaleScratch(config);

	ctx.tools.register(ownTool({
		name: 'screen_view',
		description: [
			'See the live desktop: capture the screen and return the actual image, so you can read what is on it instead of guessing.',
			'Use this before any desktop_control action, and again after acting, to confirm the result.',
			'The capture is per-monitor DPI aware and stored in physical screen pixels. The result states the request image size the model actually receives; pass imageX/imageY read from that image and the plugin maps them back to physical pixels.',
			'Defaults to the primary monitor; pass window to frame one app, screen "all" to composite every monitor, or region for a crop.',
			'Requires the current model to accept image input.'
		].join(' '),
		parameters: {
			screen: {
				type: 'string',
				description: "Which monitor: 'primary' (default), 'all' for the whole virtual desktop, or a 0-based monitor index."
			},
			window: {
				type: 'string',
				description: 'Case-insensitive substring of a window title or process name; frames that window instead of a monitor.'
			},
			region: {
				type: 'string',
				description: "Crop in physical screen pixels as 'x,y,width,height', relative to the captured area's top-left."
			},
			includeCursor: {
				type: 'boolean',
				description: 'Draw a crosshair at the pointer (default true) so you can see where it is.'
			},
			rulers: {
				type: 'boolean',
				description: 'Draw coordinate rulers on the frame — ticks every 200 px labelled with screen coordinates — so a position can be read without counting pixels (default: the rulers setting).'
			},
			forceImage: {
				type: 'boolean',
				description: 'Attach the frame even when it is pixel-identical to the previous frame of this session (default: such a duplicate is reported as unchanged and not attached).'
			}
		},
		output: {
			schema: CAPTURE_SCHEMA,
			render: (_args, value) => captureContent(value),
			presentationMeta: (_args, value) => ({ path: value.path })
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			warmWorker(config);
			await assertImageCapableRoute(ctx, exec, 'screen_view');
			const value = await capture(ctx, exec, config, { ...args, forceImage: args.forceImage === true });
			if (value.image === undefined && value.imageSkipped === undefined) {
				throw new Error(`screen_view could not attach the frame${value.imageError === undefined ? '' : `: ${value.imageError}`}`);
			}
			return pruneAbsent(value);
		},
		presentCall(args) {
			return {
				card: 'generic',
				title: args.window === undefined ? 'View screen' : `View window ${args.window}`,
				kind: 'read'
			};
		}
	}));

	ctx.tools.register(ownTool({
		name: 'desktop_control',
		description: [
			'Operate the live desktop: move the pointer, click, drag, scroll, type text, send keys, focus a window, read a window control tree, or list windows.',
			'`controls` is the cheap way to hit a named control: it returns each control role, name and rectangle, so a click becomes the centre of that rectangle (pass its index as target) instead of a guess at pixels. Reach for a screenshot when the window exposes no usable tree - a canvas, a drawing surface, or an Electron window that publishes nothing - or when you need to see what is drawn rather than what is declared.',
			'Coordinates are physical screen pixels and match screen_view images exactly, so read the target off a fresh screenshot and reuse those pixels verbatim.',
			'For a point read off a frame, prefer imageX/imageY: the plugin adds that frame origin and converts through the request image size, so no manual offset or scaling is needed. Pass imageWidth/imageHeight only when the image you are looking at is a different size from the request image.',
			'Each press, keystroke, and window focus goes to whatever is focused on the real desktop, so call screen_view first and re-check after acting when the result matters.',
			'Set capture true to receive a fresh image in the same result, which shows the effect of the action without a second round trip.',
			'Text arrives as a single paste, so applications see one insertion rather than per-character typing.',
			'Dangerous system shortcuts (win+r, ctrl+shift+esc, alt+f4, shift+delete) and a focus aimed at a UAC prompt are refused unless you pass confirm: true; pass it only after the user agreed.'
		].join(' '),
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'drag', 'scroll', 'type', 'key', 'focus', 'windows', 'controls'],
				description: 'click | doubleClick | rightClick | middleClick | move | drag | scroll | type | key | focus | windows | controls.'
			},
			x: { type: 'integer', description: 'Target x in physical screen pixels; required for the pointer actions and for scroll-at-a-point. Prefer imageX/imageY when the point was read off a frame.' },
			y: { type: 'integer', description: 'Target y in physical screen pixels; required for the pointer actions and for scroll-at-a-point. Prefer imageX/imageY when the point was read off a frame.' },
			imageX: {
				type: 'integer',
				description: 'X read off the most recent frame of this session. The plugin adds the frame origin and converts through the request image size; no manual offset or scaling.'
			},
			imageY: {
				type: 'integer',
				description: 'Y read off the most recent frame of this session. Use with imageX.'
			},
			imageWidth: {
				type: 'integer',
				description: 'Width of the image you are looking at, only when it differs from the request image size; use with imageX/imageY.'
			},
			imageHeight: {
				type: 'integer',
				description: 'Height of the image you are looking at, only when it differs from the request image size.'
			},
			imageToX: {
				type: 'integer',
				description: 'drag end X read off the same frame as imageX/imageY; the plugin translates it the same way.'
			},
			imageToY: {
				type: 'integer',
				description: 'drag end Y read off the same frame as imageX/imageY.'
			},
			toX: { type: 'integer', description: 'drag end x, or a nonzero value to make scroll horizontal.' },
			toY: { type: 'integer', description: 'drag end y, or a nonzero value to make scroll horizontal.' },
			text: { type: 'string', description: 'Text to insert for the type action.' },
			key: { type: 'string', description: "Key for the key action: a single character, 'enter', 'tab', 'esc', 'f5', or a chord such as 'ctrl+s' or 'alt+tab'." },
			amount: { type: 'integer', description: 'Wheel notches for scroll; positive scrolls up, negative down. Default 3.' },
			button: {
				type: 'string',
				enum: ['left', 'right', 'middle'],
				description: 'Mouse button for click, doubleClick, and drag. Default left.'
			},
			title: {
				type: 'string',
				description: 'Case-insensitive window title or process substring; required by focus, and filters windows.'
			},
			hwnd: {
				type: 'string',
				description: 'Lock every input of this call to one window handle ("0x1094C" or decimal). Use it when several windows share a title, or when the title changes as the window works. The helper re-asserts this window as the foreground before each injection and fails loudly if it disappeared.'
			},
			tolerant: {
				type: 'boolean',
				description: 'focus only: when Windows refuses to hand the window the foreground, record a note and continue instead of failing the step. Use it when the coordinates are right whichever window ends up in front.'
			},
			target: {
				type: 'integer',
				description: 'Click a control instead of a coordinate: the index number from a controls listing of the same window. The listing is re-read before the click, so an index that no longer resolves fails rather than hitting whatever moved into that slot.'
			},
			includeValues: {
				type: 'boolean',
				description: 'controls only: also return each control current value (edit boxes, text). Off by default, because a value is content rather than structure; password fields are always masked.'
			},
			meaningfulOnly: {
				type: 'boolean',
				description: 'controls only, default true: return just the controls a person can operate (buttons, edits, list rows, menus, tabs, check boxes...). Measured on a real 673-element window the filtered listing is 77 elements and about 850 tokens, against 9k for all of them, because the rest is layout panes with no name and nothing to click. Pass false when you need the whole tree - for example to see how a window is composed rather than what can be operated.'
			},
			includeHidden: {
				type: 'boolean',
				description: 'windows only, default false: also list invisible, off-screen, and zero-area helper windows. Leave it off for a readable list; turn it on when you are hunting a window that really is hidden to the tray.'
			},
			capture: {
				type: 'boolean',
				description: 'Capture a fresh frame after the action and show it in this result. Default true.'
			},
			settleMs: {
				type: 'integer',
				description: 'Milliseconds to wait before the automatic capture, so the screen can repaint. Default 750. Skipped when capture is false, unless you pass it explicitly.'
			},
			forceImage: {
				type: 'boolean',
				description: 'Attach the frame even when the screen is pixel-identical to the previous one (default: such a duplicate is not attached again).'
			},
			confirm: {
				type: 'boolean',
				description: 'Dangerous actions only: confirms that the user agreed to this exact shortcut or UAC focus. The call is refused before touching the desktop without it.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					cursor: {
						type: 'object',
						additionalProperties: false,
						properties: {
							x: { type: 'integer', required: true },
							y: { type: 'integer', required: true },
							screen: { type: 'string' }
						}
					},
					foregroundTitle: { type: 'string' },
					foregroundClass: { type: 'string' },
					foregroundProcess: { type: 'string' },
					notes: { type: 'array', items: { type: 'string' } },
					windows: { type: 'array', items: WINDOW_INFO_SCHEMA },
					windowCount: { type: 'integer' },
					controls: { type: 'array', items: { type: 'string' } },
					controlCount: { type: 'integer' },
					controlsTruncated: { type: 'boolean' },
					controlTotal: { type: 'integer' },
					filteredOut: { type: 'integer' },
					controlsWindow: { type: 'string' },
					actedAt: { type: 'string' },
					capture: CAPTURE_SCHEMA,
					capturePath: { type: 'string' },
					captureError: { type: 'string' },
					frameHash: { type: 'string' },
					unchanged: { type: 'boolean' },
					imageSkipped: { type: 'string' }
				}
			},
			render: (_args, value) => {
				const blocks = [{ type: 'text', text: controlText(value) }];
				if (value.capture !== null && value.capture !== undefined && value.capture.image !== undefined) {
					blocks.push({ type: 'image', attachment: value.capture.image });
				}
				return blocks;
			}
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			warmWorker(config);
			// Reading the control tree is the alternative to taking a frame, so it does not
			// take one unless asked: a caller that wants both still gets both.
			const wantsCapture = args.capture === undefined ? args.action !== 'controls' : args.capture === true;
			if (wantsCapture) await assertImageCapableRoute(ctx, exec, 'desktop_control with capture');
			// Hard guard before anything touches the desktop. The model's own risk
			// declaration is not consulted here: win+r labelled low is still win+r.
			const hazard = assertActionAllowed(args, config);

			// The settle exists so a frame is not taken mid-repaint. With no frame to
			// take there is nothing to wait for, and the wait is dead time: measured
			// 750 ms on every desktop_control call, capturing or not. An explicit
			// settleMs is still honoured, so a caller that wants a pause before its
			// own screen_view keeps it.
			const explicitSettle = Number.isSafeInteger(args.settleMs);
			const settle = explicitSettle ? args.settleMs : (wantsCapture ? config.settleMs : 0);
			const params = { action: args.action, settleMs: settle };
			for (const field of ['x', 'y', 'toX', 'toY', 'amount', 'text', 'key', 'title', 'hwnd', 'button', 'tolerant', 'target', 'includeValues', 'meaningfulOnly']) {
				if (args[field] !== undefined && args[field] !== null) params[field] = args[field];
			}
			const translated = translateImageCoords(exec, args);
			if (translated?.start !== undefined) {
				params.x = translated.start.x;
				params.y = translated.start.y;
			}
			if (translated?.end !== undefined) {
				params.toX = translated.end.x;
				params.toY = translated.end.y;
			}

			const options = optionsFor(exec, config);
			const acted = await runAction(params, config, options, undefined, describeAction(args));
			// Copy the declared fields only: the helper's own bookkeeping keys
			// must not reach the closed output schema.
			const value = { action: args.action };
			// A one-element list can still arrive unrolled from the helper; the output
			// schema wants an array, and a string here is a rejected result, not a bug the
			// caller can see.
			if (typeof acted.controls === 'string') acted.controls = [acted.controls];
			for (const field of ['cursor', 'foregroundTitle', 'foregroundClass', 'foregroundProcess', 'notes', 'windowCount', 'actedAt', 'controls', 'controlCount', 'controlsTruncated', 'controlsWindow', 'controlTotal', 'filteredOut']) {
				if (acted[field] !== undefined) value[field] = acted[field];
			}
			// The list is projected, not copied: the sensor's window entries carry
			// fields of their own (`visible`, bookkeeping) and this schema is closed.
			if (Array.isArray(acted.windows)) {
				const projected = acted.windows.map((entry) => windowInfoOf(entry)).filter((entry) => entry !== undefined);
				if (args.action === 'windows' && args.includeHidden !== true) {
					const visible = projected.filter((entry) => entry.visible !== false && boundsArea(entry.bounds) > 1);
					const hidden = projected.length - visible.length;
					value.windows = visible;
					value.windowCount = visible.length;
					if (hidden > 0) {
						value.notes = [
							...(Array.isArray(value.notes) ? value.notes : []),
							`已隐藏 ${hidden} 个不可见、离屏或零面积的辅助窗口；需要时传 includeHidden: true。`
						];
					}
				} else {
					value.windows = projected;
					value.windowCount = projected.length;
				}
			}
			if (hazard !== undefined) {
				value.notes = [
					...(Array.isArray(value.notes) ? value.notes : []),
					`危险操作已确认后执行：${hazard}`
				];
			}

			if (wantsCapture) {
				try {
					const frame = await capture(ctx, exec, config, { includeCursor: true, forceImage: args.forceImage === true });
					value.capture = frame;
					value.capturePath = frame.path;
					if (frame.frameHash !== undefined) value.frameHash = frame.frameHash;
					if (frame.unchanged !== undefined) value.unchanged = frame.unchanged;
					if (frame.imageSkipped !== undefined) value.imageSkipped = frame.imageSkipped;
					if (frame.image === undefined && frame.imageError !== undefined) value.captureError = frame.imageError;
				} catch (error) {
					value.captureError = error instanceof Error ? error.message : String(error);
				}
			}
			return pruneAbsent(value);
		},
		presentCall(args) {
			return {
				card: 'generic',
				title: `Desktop ${args.action}${args.title === undefined ? '' : ` ${args.title}`}`,
				kind: 'execute'
			};
		}
	}));

	ctx.tools.register(ownTool({
		name: 'desktop_sequence',
		description: [
			'Run several desktop actions in ONE call: focus, click, type, key, scroll … then look once at the end.',
			'This is the fast path. Calling desktop_control once per action costs one model round trip and one screenshot per action; a batch costs one round trip and, by default, a single frame — that difference, not the click speed, is what makes desktop work feel quick.',
			'Steps accept imageX/imageY read off the most recent frame of this session; the plugin translates them to physical pixels. Physical x/y still works.',
			'Each step is a desktop_control action without its own screenshot, and steps run in order. By default the batch stops at the first failure, so a refused focus can never be followed by typing into the wrong window.',
			'After the last step the result carries one frame — by default of the window that was foreground during the batch, not the whole desktop — plus a frame_hash. When that hash matches the previous frame the image is not attached again; pass forceImage: true to see it anyway.',
			'Declare risk honestly: "low" (default) batches freely; a batch that is medium/high — at the batch level or on any step — is refused unless you pass confirm: true, which you do only after the user has agreed. Dangerous system shortcuts are raised to high automatically, whatever the step declared. dryRun: true validates the batch and lists the plan without touching the desktop.',
			'Batch the low-risk steps of a task and verify once at the end; only stop to screenshot in the middle when the UI state is genuinely uncertain.'
		].join(' '),
		parameters: {
			steps: {
				type: 'array',
				required: true,
				description: 'Ordered steps. Each object is one desktop_control action: {action, x, y, toX, toY, imageX, imageY, imageToX, imageToY, imageWidth, imageHeight, text, key, title, hwnd, amount, button, tolerant, settleMs, risk, riskNote}; action "wait" takes ms. Prefer imageX/imageY for points read off a frame; they are translated to physical pixels with the frame origin and scale. A focus step that Windows refuses now fails unless tolerant: true.'
			},
			risk: {
				type: 'string',
				enum: RISKS,
				description: 'Risk you declare for the whole batch (default low). medium/high requires confirm: true.'
			},
			confirm: {
				type: 'boolean',
				description: 'Explicit approval for a medium/high-risk batch. Without it the tool refuses before touching the desktop.'
			},
			dryRun: {
				type: 'boolean',
				description: 'Validate the batch and list the plan without executing anything.'
			},
			capture: {
				type: 'string',
				enum: ['end', 'none'],
				description: "end (default) captures one frame after the last step; none skips the frame entirely."
			},
			target: {
				type: 'string',
				enum: ['window', 'screen', 'all'],
				description: "What the end frame shows: window (default) = the window that was foreground during the batch, screen = the primary monitor, all = the whole virtual desktop."
			},
			window: {
				type: 'string',
				description: 'Frame this window instead (case-insensitive title or process substring), overriding target.'
			},
			region: {
				type: 'string',
				description: "Crop the end frame in physical pixels as 'x,y,width,height'."
			},
			forceImage: {
				type: 'boolean',
				description: 'Attach the end frame even when it is pixel-identical to the previous frame.'
			},
			stopOnError: {
				type: 'boolean',
				description: 'Stop at the first failing step (default true); false keeps going and reports every failure.'
			},
			settleMs: {
				type: 'integer',
				description: 'Delay before the end capture so the screen can repaint (default: the configured settleMs).'
			}
		},
		output: {
			schema: SEQUENCE_SCHEMA,
			render: (_args, value) => sequenceText(value),
			// `capturePath` is optional in SEQUENCE_SCHEMA: a dry run, capture:'none' and a
			// failed end capture all return without one. The projector must therefore omit
			// the key rather than emit `{ path: undefined }` — an undefined property is not
			// lossless JSON, and the runtime rejects the whole result *after* the batch ran.
			presentationMeta: (_args, value) => (typeof value.capturePath === 'string' ? { path: value.capturePath } : {})
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			warmWorker(config);
			const steps = normalizeSequence({ ...args, steps: translateSequenceSteps(exec, args.steps) }, config);
			const risk = sequenceRisk(steps, args.risk, args.confirm, config);
			const confirmed = args.confirm === true;

			if (args.dryRun === true) {
				return pruneAbsent({
					risk,
					confirmed,
					planned: true,
					stepCount: steps.length,
					executed: 0,
					failed: 0,
					steps: steps.map((step, offset) => {
						const hazard = config.guardDangerous === true ? hazardOf(step) : undefined;
						return {
							index: offset + 1,
							action: step.action,
							ok: true,
							ms: 0,
							...(hazard !== undefined ? { risk: 'high' } : step.risk === undefined ? {} : { risk: step.risk }),
							...(hazard !== undefined ? { note: hazard } : typeof step.riskNote === 'string' ? { note: step.riskNote } : {})
						};
					}),
					notes: ['dry run: nothing was executed']
				});
			}

			const wantsFrame = args.capture !== 'none';
			if (wantsFrame) await assertImageCapableRoute(ctx, exec, 'desktop_sequence with capture');
			const options = optionsFor(exec, config);
			const stopOnError = args.stopOnError !== false;
			const results = [];
			let failed = 0;
			// One token and one ring cover the whole batch, so Esc stops the batch rather
			// than the single step that happened to be running when the key landed.
			const batchCancel = join(scratchDir(), `cancel-${nextToken()}.txt`);
			const batchStarted = Date.now();
			const batchDir = beginTakeover(batchCancel, config, describeStep(steps[0], 0, steps.length));
			let cancelledByEsc = false;
			try {
				for (const [offset, step] of steps.entries()) {
					if (exec?.signal?.aborted) throw new Error('desktop_sequence: the batch was cancelled');
					if (stopRequested(batchCancel)) {
						cancelledByEsc = true;
						break;
					}
					const stepLabel = describeStep(step, offset, steps.length);
					writeTakeoverLabel(batchDir, stepLabel);
					const stepStarted = Date.now();
					try {
						const entry = await runSequenceStep(step, config, options, batchCancel, stepLabel);
						results.push({ index: offset + 1, ...entry, ...(step.risk === undefined ? {} : { risk: step.risk }) });
					} catch (error) {
						failed += 1;
						results.push({
							index: offset + 1,
							action: step.action,
							ok: false,
							ms: Date.now() - stepStarted,
							note: error instanceof Error ? error.message : String(error),
							...(step.risk === undefined ? {} : { risk: step.risk })
						});
						if (error?.cancelled === true) {
							cancelledByEsc = true;
							break;
						}
						if (stopOnError) break;
					}
				}
			} finally {
				cancelledByEsc = cancelledByEsc || tookEsc(batchDir, batchStarted);
				endTakeover(batchDir);
				try {
					rmSync(batchCancel, { force: true });
				} catch {
					// The token is unique, so a leftover file cannot cancel anything else.
				}
			}

			const value = {
				risk,
				confirmed,
				planned: false,
				stepCount: steps.length,
				executed: results.filter((entry) => entry.ok).length,
				failed,
				steps: results,
				actedAt: new Date().toISOString()
			};
			if (cancelledByEsc) value.notes = ['the person pressed Esc; the batch stopped where it was'];
			const lastCursor = [...results].reverse().find((entry) => entry.cursor !== undefined);
			if (lastCursor !== undefined) value.cursor = lastCursor.cursor;
			const lastForeground = [...results].reverse().find((entry) => entry.foregroundTitle !== undefined);
			if (lastForeground !== undefined) value.foregroundTitle = lastForeground.foregroundTitle;

			if (wantsFrame) {
				try {
					await abortableWait(Number.isSafeInteger(args.settleMs) ? args.settleMs : config.settleMs, exec?.signal);
					const captureArgs = { includeCursor: false };
					if (typeof args.window === 'string' && args.window.trim().length > 0) captureArgs.window = args.window.trim();
					else if (args.target === 'all') captureArgs.screen = 'all';
					else if (args.target === 'screen') captureArgs.screen = 'primary';
					else if (typeof value.foregroundTitle === 'string' && value.foregroundTitle.length > 0) captureArgs.window = value.foregroundTitle;
					else captureArgs.screen = 'primary';
					if (typeof args.region === 'string' && args.region.trim().length > 0) captureArgs.region = args.region.trim();
					const frame = await capture(ctx, exec, config, { ...captureArgs, forceImage: args.forceImage === true });
					value.capture = frame;
					value.capturePath = frame.path;
					if (frame.frameHash !== undefined) value.frameHash = frame.frameHash;
					if (frame.unchanged !== undefined) value.unchanged = frame.unchanged;
					if (frame.imageSkipped !== undefined) value.imageSkipped = frame.imageSkipped;
					if (frame.image === undefined && frame.imageError !== undefined) value.captureError = frame.imageError;
				} catch (error) {
					value.captureError = error instanceof Error ? error.message : String(error);
				}
			}
			return pruneAbsent(value);
		},
		presentCall(args) {
			const count = Array.isArray(args?.steps) ? args.steps.length : 0;
			return {
				card: 'generic',
				title: `Desktop batch (${count} step${count === 1 ? '' : 's'})`,
				kind: 'execute'
			};
		}
	}));


	// The settings page is optional: a composition without a web server still gets
	// the tools. The route writes through the profile's own config editor.
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(
			() => registerSettingsApi(webCtx, ctx, () => config, () => ({
				shell: describeShell(shellRuntime),
				tempDir: tempRoot(),
				platform: process.platform
			})),
			'see-touch: settings api'
		);
	});

	// The warm worker lives exactly as long as the plugin does.
	try {
		ctx.effect(() => () => {
			void actionWorker.stop();
			closeOverlay();
		});
	} catch {
		// A host without an effect surface keeps the worker until the process exits.
	}
}

export { apply, hazardOf, inject, name, ownTool, parameterSchema, pruneAbsent, resolveConfig, valueSchema, windowInfoOf };

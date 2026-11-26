/**
 * Settings API for 我看得见也摸得到.
 *
 * GET  /see-touch-api/state   → the effective configuration plus which PowerShell
 *                               was resolved and where temp files live.
 * POST /see-touch-api/config  → a partial patch; it is persisted through the profile's
 *                               config editor, which restarts the plugin so the next
 *                               call uses the new values.
 */

import { cleanPatch } from './config.js';

const PREFIX = '/see-touch-api';
const MAX_BODY_BYTES = 16 * 1024;

/** Write one JSON response. */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

/** Write one structured failure. */
function fail(res, status, message) {
	sendJson(res, status, { ok: false, error: { message } });
}

/** Build an Error that carries its HTTP status. */
function httpError(message, status) {
	return Object.assign(new Error(message), { status });
}

/** Read a bounded JSON body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) throw httpError('请求体过大', 413);
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw httpError('请求体不是合法 JSON', 400);
	}
}

/** Refuse a cross-site write. */
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin !== 'string' || origin === '') return true;
	const host = req.headers.host;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** Persist a partial patch into the plugin's own profile row. */
async function writePatch(pluginCtx, patch) {
	const entry = pluginCtx.fiber === undefined ? undefined : pluginCtx.fiber.entry;
	const editor = pluginCtx.get('configEditor');
	if (entry === undefined || editor === undefined) {
		throw httpError('这个 profile 不支持在页面上保存插件配置', 501);
	}
	await editor.edit(entry, (current, inherited) => {
		const base = current !== null && typeof current === 'object' ? current : inherited;
		return { ...(base !== null && typeof base === 'object' ? base : {}), ...patch };
	});
}

/**
 * Register the settings routes on the composition's web server.
 *
 * @param webCtx - a context that has `webServer`.
 * @param pluginCtx - the plugin's own context, whose fiber owns the profile row.
 * @param getConfig - returns the effective configuration.
 * @param getRuntime - returns shell/temp facts for the page.
 * @returns the route disposer.
 */
export function registerSettingsApi(webCtx, pluginCtx, getConfig, getRuntime) {
	const handle = async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const path = url.pathname.slice(PREFIX.length) || '/';
		if (req.method === 'GET' && path === '/state') {
			sendJson(res, 200, {
				ok: true,
				data: { config: getConfig(), runtime: getRuntime() }
			});
			return;
		}
		if (req.method === 'POST' && path === '/config') {
			if (!sameOrigin(req)) {
				fail(res, 403, '拒绝跨站修改配置');
				return;
			}
			const body = await readJson(req);
			const patch = body.config;
			if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
				throw httpError('config 必须是一个对象', 400);
			}
			const clean = cleanPatch(getConfig(), patch);
			await writePatch(pluginCtx, clean);
			sendJson(res, 200, { ok: true, data: { saved: clean } });
			return;
		}
		fail(res, 404, '未知接口');
	};
	return webCtx.webServer.register({
		kind: 'prefix',
		path: PREFIX,
		handler: (req, res) => {
			handle(req, res).catch((error) => {
				if (res.headersSent) {
					res.end();
					return;
				}
				const status = Number(error?.status) || 500;
				fail(res, status, error instanceof Error ? error.message : String(error));
			});
		}
	});
}

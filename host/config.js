/**
 * Configuration for 我看得见也摸得到.
 *
 * The plugin declares no Config schema on purpose: the profile row is a plain YAML
 * mapping, and every value is validated here instead. That keeps the package free of
 * runtime imports, so a workspace directory can be linked into any profile.
 */

/** Defaults used when the profile row leaves a field out. */
export const DEFAULT_CONFIG = Object.freeze({
	/** Where frames are saved: the OS temp directory, or `.see-touch` inside the session workspace. */
	captureLocation: 'temp',
	/** How many frames one capture directory keeps. */
	captureRetention: 20,
	/** Delete frames older than this many days (0 disables the age limit). */
	captureMaxAgeDays: 7,
	/** Delete frames beyond this total size in MB (0 disables the size limit). */
	captureMaxTotalMB: 300,
	/** Hard deadline for one capture or one action, in milliseconds. */
	timeoutMs: 20000,
	/** Default wait between an action and its automatic frame. */
	settleMs: 750,
	/** Per-step wait inside a batch. */
	stepSettleMs: 120,
	/** Hard cap on the steps one desktop_sequence call may run. */
	maxSequenceSteps: 24,
	/** Keep one PowerShell process warm, so an action costs milliseconds rather than a process start. */
	useWorker: true,
	/** Draw coordinate rulers on every frame. */
	rulers: true,
	/** Also save a frame when a tool result carries no image. */
	alwaysSaveFile: true,
	/** Show the takeover ring and accept Esc while an action runs. */
	takeover: true,
	/** How long the ring lingers after the last action of a round. */
	takeoverLingerMs: 3000,
	/** PowerShell engine: auto prefers PowerShell 7 (pwsh), then Windows PowerShell 5.1. */
	shell: 'auto',
	/** Refuse dangerous system shortcuts until the caller passes confirm: true. */
	guardDangerous: true
});

/** Human labels used in validation errors and the settings page. */
const LABELS = {
	captureLocation: '截图保存位置',
	captureRetention: '截图保留张数',
	captureMaxAgeDays: '截图最长保留天数',
	captureMaxTotalMB: '截图目录容量上限',
	timeoutMs: '单次操作超时',
	settleMs: '动作后等待',
	stepSettleMs: '批量步骤间隔',
	maxSequenceSteps: '单批最多步数',
	useWorker: '常驻进程',
	rulers: '坐标尺',
	alwaysSaveFile: '总是保存截图文件',
	takeover: '桌面接管提示环',
	takeoverLingerMs: '提示环停留',
	shell: 'PowerShell 引擎',
	guardDangerous: '危险操作守卫'
};

/** Integer fields and their inclusive ranges. */
const INT_RANGES = {
	captureRetention: [1, 500],
	captureMaxAgeDays: [0, 3650],
	captureMaxTotalMB: [0, 100000],
	timeoutMs: [1000, 180000],
	settleMs: [0, 10000],
	stepSettleMs: [0, 10000],
	maxSequenceSteps: [1, 100],
	takeoverLingerMs: [0, 600000]
};

/** Boolean fields. */
const BOOL_FIELDS = new Set(['useWorker', 'rulers', 'alwaysSaveFile', 'takeover', 'guardDangerous']);

/** Enumerated fields. */
const ENUMS = {
	captureLocation: ['temp', 'workspace'],
	shell: ['auto', 'pwsh', 'powershell']
};

/** Fields the settings page may write. Other keys are readable but not editable there. */
export const EDITABLE_KEYS = Object.freeze([
	'captureLocation',
	'captureRetention',
	'captureMaxAgeDays',
	'captureMaxTotalMB',
	'takeover',
	'takeoverLingerMs',
	'rulers',
	'guardDangerous',
	'shell',
	'settleMs'
]);

/** Every recognized key. */
const ALL_KEYS = new Set([
	...Object.keys(INT_RANGES),
	...BOOL_FIELDS,
	...Object.keys(ENUMS)
]);

/** Throw one readable error for one bad field. */
function reject(key, detail) {
	const label = LABELS[key] ?? key;
	throw new Error(`${label}（${key}）${detail}`);
}

/**
 * Validate and fill one raw configuration mapping.
 *
 * Unknown keys are ignored (a profile layer may carry another version's field), and
 * absent keys take their default. A present but invalid value is an error, never a
 * silent fallback: a typo in a safety switch must not leave the guard off.
 *
 * @param raw - the profile row's config, or undefined.
 * @returns a complete, validated configuration object.
 */
export function resolveConfig(raw) {
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	const config = { ...DEFAULT_CONFIG };
	for (const key of ALL_KEYS) {
		if (!Object.hasOwn(source, key) || source[key] === undefined || source[key] === null) continue;
		const value = source[key];
		if (INT_RANGES[key] !== undefined) {
			const [min, max] = INT_RANGES[key];
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
				reject(key, `必须是 ${min}–${max} 之间的整数`);
			}
			config[key] = value;
			continue;
		}
		if (BOOL_FIELDS.has(key)) {
			if (typeof value !== 'boolean') reject(key, '必须是 true 或 false');
			config[key] = value;
			continue;
		}
		const allowed = ENUMS[key];
		if (!allowed.includes(value)) reject(key, `只能是 ${allowed.join(' / ')}`);
		config[key] = value;
	}
	return config;
}

/**
 * Merge a partial settings patch over the effective configuration.
 *
 * Only editable keys are accepted, and only keys that really appear in the patch are
 * written back, so saving one switch cannot freeze every other field into the profile
 * override row.
 *
 * @param current - the effective configuration.
 * @param patch - the partial mapping from the settings page.
 * @returns the clean partial mapping to persist.
 */
export function cleanPatch(current, patch) {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
		throw new Error('设置内容必须是一个对象');
	}
	const clean = {};
	for (const key of Object.keys(patch)) {
		if (!EDITABLE_KEYS.includes(key)) throw new Error(`设置项 ${key} 不能在页面上修改`);
		clean[key] = patch[key];
	}
	// Validate against the full effective configuration so a partial patch still sees
	// every field's true value.
	resolveConfig({ ...current, ...clean });
	return clean;
}

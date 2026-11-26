window.__ModuleLoader__.load({
  id: '@local/see-touch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'see-touch';
    const API = '/see-touch-api';

    /* -------------------------------------------------------------- */
    /* Copy                                                           */
    /* -------------------------------------------------------------- */

    const zh = {
      nav: '看得见也摸得到',
      kicker: '看见 · 摸到',
      title: '我看得见也摸得到',
      subtitle: '先看一眼，再动手。截图存哪、接管环停多久、哪些键必须你点头，都在这里定。',
      eyes: '我的眼睛',
      hands: '我的手',
      engine: '引擎',
      location: '截图存哪',
      locationTemp: '系统临时目录',
      locationTempNote: '默认。工程目录干干净净，不会多出一个隐藏文件夹。',
      locationWorkspace: '当前工程目录',
      locationWorkspaceNote: '存到工作区的 .see-touch/ 里，并自动放一个 .gitignore 让 git 无视它。',
      retention: '清理规则',
      keepCount: '保留张数',
      retentionUnit: '张',
      retentionNote: '超过就删最旧的，聊天里已经发出的图片不受影响。',
      maxAge: '最长保留',
      maxAgeUnit: '天',
      maxAgeNote: '0 表示不按天数清理。',
      maxTotal: '目录容量上限',
      maxTotalUnit: 'MB',
      maxTotalNote: '0 表示不按体积清理。',
      rulers: '坐标尺',
      rulersNote: '每帧边缘画刻度并标屏幕坐标，读位置不用数像素。',
      takeover: '接管提示环',
      takeoverNote: '我操作时屏幕边缘亮一圈，随时按 Esc 我就停。',
      linger: '提示环停留',
      lingerUnit: '秒',
      lingerNote: '一轮操作结束后多亮一会儿，别让人没看见就没了。',
      guard: '危险键守卫',
      guardNote: 'win+r、ctrl+shift+esc、alt+f4、shift+delete 以及 UAC 窗口的焦点，未确认前直接拒绝。',
      guardBadge: '建议常开',
      shell: 'PowerShell 引擎',
      shellAuto: '自动',
      shellAutoNote: '优先 PowerShell 7（pwsh），没有就退回 5.1。',
      shellPwsh: 'PowerShell 7',
      shellPwshNote: '更快、默认 UTF-8；没装会明确报错。',
      shell51: 'Windows PowerShell 5.1',
      shell51Note: '每台 Windows 都有，启动和编译稍慢。',
      resolved: '当前使用',
      settle: '动作后等待',
      settleUnit: '毫秒',
      settleNote: '点完到截图之间留一点时间让界面重绘；只影响带截图的操作。',
      tempDir: '临时目录',
      save: '保存设置',
      saving: '正在保存…',
      saved: '已保存。插件按新设置重启，下一步就用上了。',
      unchanged: '没有改动。',
      loading: '正在读取设置…',
      loadFailed: '读取设置失败',
      saveFailed: '保存失败',
      rangeError: '请填范围内的整数：',
      lingerError: '提示环停留要填 0–600 秒之间的数字。',
      retry: '重试',
      loginHint: '登录状态已失效，刷新页面后再试。',
      foot: '配置写进 profile，重启 DSH 也保留。截图里的坐标始终是物理像素，和屏幕上一一对应。',
      pathHint: '路径只是提示，实际目录按当前会话决定。'
    };

    const en = {
      nav: 'See & touch',
      kicker: 'SEE · TOUCH',
      title: 'I can see, and I can touch',
      subtitle: 'I look first, then move. Where frames go, how long the takeover ring stays, and which keys need your nod are all decided here.',
      eyes: 'My eyes',
      hands: 'My hands',
      engine: 'Engine',
      location: 'Where frames go',
      locationTemp: 'OS temp folder',
      locationTempNote: 'Default. Your project stays clean, with no hidden frame folder.',
      locationWorkspace: 'Current workspace',
      locationWorkspaceNote: 'Saved under .see-touch/ with a one-line .gitignore so git ignores it.',
      retention: 'Cleanup rules',
      keepCount: 'Frames to keep',
      retentionUnit: 'frames',
      retentionNote: 'The oldest frames go first; images already in the chat are unaffected.',
      maxAge: 'Maximum age',
      maxAgeUnit: 'days',
      maxAgeNote: '0 disables the age limit.',
      maxTotal: 'Folder size cap',
      maxTotalUnit: 'MB',
      maxTotalNote: '0 disables the size limit.',
      rulers: 'Coordinate rulers',
      rulersNote: 'Ticks with screen coordinates along the frame, so a position does not need pixel counting.',
      takeover: 'Takeover ring',
      takeoverNote: 'A light ring around the screen while I act; press Esc to stop me.',
      linger: 'Ring lingers',
      lingerUnit: 'seconds',
      lingerNote: 'A short tail after a round, so it is not easy to miss.',
      guard: 'Dangerous-key guard',
      guardNote: 'win+r, ctrl+shift+esc, alt+f4, shift+delete, and focus on a UAC prompt are refused until confirmed.',
      guardBadge: 'keep on',
      shell: 'PowerShell engine',
      shellAuto: 'Auto',
      shellAutoNote: 'Prefers PowerShell 7 (pwsh), falls back to 5.1.',
      shellPwsh: 'PowerShell 7',
      shellPwshNote: 'Faster and UTF-8 by default; reports clearly when missing.',
      shell51: 'Windows PowerShell 5.1',
      shell51Note: 'Present on every Windows install; slower to start and compile.',
      resolved: 'In use',
      settle: 'Wait after acting',
      settleUnit: 'ms',
      settleNote: 'Lets the UI repaint before the frame; only affects calls that capture.',
      tempDir: 'Temp folder',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Saved. The plugin restarted with these values and uses them on the next step.',
      unchanged: 'Nothing changed.',
      loading: 'Loading settings…',
      loadFailed: 'Could not load settings',
      saveFailed: 'Save failed',
      rangeError: 'Enter a whole number in range:',
      lingerError: 'Enter a number of seconds between 0 and 600.',
      retry: 'Retry',
      loginHint: 'Your session expired; reload the page and try again.',
      foot: 'Settings live in the profile and survive a DSH restart. Frame coordinates are always physical pixels, matching the screen one to one.',
      pathHint: 'The path is a hint; the actual folder depends on the session.'
    };

    /* -------------------------------------------------------------- */
    /* Styles                                                         */
    /* -------------------------------------------------------------- */

    const CSS = `
.st-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 30px;
  color: var(--dsw-alias-label-primary);
  max-width: 760px;
}
.st-head { display: flex; flex-direction: column; gap: 6px; }
.st-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--dsw-alias-brand-primary);
}
.st-kicker::before {
  content: '';
  width: 18px;
  height: 1px;
  background: currentColor;
  opacity: .7;
}
.st-title { margin: 0; font-size: 22px; font-weight: 680; line-height: 1.25; letter-spacing: -.01em; }
.st-sub { margin: 0; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.st-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
}
.st-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.st-card-title { margin: 0; font-size: 14px; font-weight: 640; }
.st-card-en { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); opacity: .8; }
.st-row { display: flex; flex-direction: column; gap: 8px; }
.st-row + .st-row { padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.st-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-row-title { font-size: 13px; font-weight: 570; }
.st-row-note { margin: 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.st-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.st-num { display: flex; flex-direction: column; gap: 5px; }
.st-num-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.st-num-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
}
.st-num-wrap:focus-within { border-color: var(--dsw-alias-brand-primary); }
.st-num-wrap input {
  width: 100%;
  min-width: 0;
  padding: 8px 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.st-num-wrap input::-webkit-outer-spin-button,
.st-num-wrap input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.st-unit { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.st-seg { display: flex; flex-wrap: wrap; gap: 6px; }
.st-seg-btn {
  padding: 7px 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.2;
  cursor: pointer;
  transition: border-color .15s ease, color .15s ease, background .15s ease;
}
.st-seg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.st-seg-btn.is-active {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.st-seg-btn:disabled { opacity: .55; cursor: default; }
.st-toggle {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}
.st-toggle.is-disabled { opacity: .6; }
.st-toggle-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.st-toggle-track {
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  margin-top: 1px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  cursor: pointer;
  transition: background .18s ease;
}
.st-toggle-track.is-on { background: var(--dsw-alias-brand-primary); }
.st-toggle-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.28);
  transition: transform .18s ease;
}
.st-toggle-track.is-on::after { transform: translateX(16px); }
.st-toggle-track:disabled { cursor: default; opacity: .55; }
.st-toggle-track:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.st-badge {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent);
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
  white-space: nowrap;
}
.st-runtime {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 9px 11px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.st-runtime b { flex: none; font-weight: 600; color: var(--dsw-alias-label-primary); }
.st-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.st-save {
  padding: 9px 18px;
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: 10px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .15s ease;
}
.st-save:disabled { opacity: .5; cursor: default; }
.st-status { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.st-status.is-pending { color: var(--dsw-alias-label-secondary); }
.st-error {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--dsw-alias-state-error-primary);
}
.st-link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.st-foot { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
@media (max-width: 520px) {
  .st-card { padding: 14px; }
  .st-page { gap: 12px; }
}
`;

    /* -------------------------------------------------------------- */
    /* Navigation icon                                                */
    /* -------------------------------------------------------------- */

    function NavIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 36 36',
        fill: 'none',
        'aria-hidden': 'true'
      },
      h('path', {
        d: 'M3.2 17.6C7.6 10.9 28.4 10.9 32.8 17.6 28.4 24.3 7.6 24.3 3.2 17.6Z',
        stroke: 'currentColor', strokeWidth: 2.2,
        strokeLinecap: 'round', strokeLinejoin: 'round'
      }),
      h('circle', { cx: 18, cy: 17.6, r: 4.6, stroke: 'currentColor', strokeWidth: 2.2 }),
      h('path', {
        d: 'M21.4 22.2 25 32l2.5-3.6 4.1 1.4-2.3-3.9 3.4-1.7-11.3-2Z',
        fill: 'currentColor'
      }));
    }

    /* -------------------------------------------------------------- */
    /* API                                                            */
    /* -------------------------------------------------------------- */

    async function request(path, options = {}) {
      const init = {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      };
      if (options.body !== undefined) {
        init.method = 'POST';
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(API + path, init);
      let payload = null;
      try { payload = await response.json(); } catch { /* not JSON */ }
      if (response.status === 401 || response.status === 403) throw new Error('UNAUTHORIZED');
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      }
      return payload.data;
    }

    function errorText(error, t) {
      if (error && error.message === 'UNAUTHORIZED') return t('loginHint');
      return error instanceof Error ? error.message : String(error);
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /* -------------------------------------------------------------- */
    /* Controls                                                       */
    /* -------------------------------------------------------------- */

    function Segmented({ value, options, onChange, disabled }) {
      return h('div', { className: 'st-seg', role: 'group' },
        options.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          className: 'st-seg-btn' + (value === entry.id ? ' is-active' : ''),
          'aria-pressed': value === entry.id,
          disabled: disabled === true,
          onClick: () => onChange(entry.id)
        }, entry.label)));
    }

    function Toggle({ checked, onChange, disabled, title, note, badge }) {
      return h('div', { className: 'st-toggle' + (disabled === true ? ' is-disabled' : '') },
        h('span', { className: 'st-toggle-copy' },
          h('span', { className: 'st-row-head' },
            h('span', { className: 'st-row-title' }, title),
            badge ? h('span', { className: 'st-badge' }, badge) : null),
          note ? h('span', { className: 'st-row-note' }, note) : null),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': title,
          className: 'st-toggle-track' + (checked === true ? ' is-on' : ''),
          disabled: disabled === true,
          onClick: () => onChange(checked !== true)
        }));
    }

    function NumberBox({ label, value, min, max, step, unit, onChange, disabled }) {
      return h('label', { className: 'st-num' },
        h('span', { className: 'st-num-label' }, label),
        h('span', { className: 'st-num-wrap' },
          h('input', {
            type: 'number',
            value,
            min,
            max,
            step: step ?? 1,
            disabled: disabled === true,
            onChange: (event) => onChange(event.target.value)
          }),
          unit ? h('span', { className: 'st-unit' }, unit) : null));
    }

    /* -------------------------------------------------------------- */
    /* Page                                                           */
    /* -------------------------------------------------------------- */

    const NUMERIC = {
      captureRetention: { min: 1, max: 500, integer: true, labelKey: 'keepCount' },
      captureMaxAgeDays: { min: 0, max: 3650, integer: true, labelKey: 'maxAge' },
      captureMaxTotalMB: { min: 0, max: 100000, integer: true, labelKey: 'maxTotal' },
      settleMs: { min: 0, max: 10000, integer: true, labelKey: 'settle' }
    };

    function SettingsPage({ t }) {
      const [form, setForm] = useState(null);
      const [runtime, setRuntime] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState(null);
      const [savedFlash, setSavedFlash] = useState(false);
      const mounted = useRef(true);

      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      const applyState = useCallback((data) => {
        setForm({
          captureLocation: data.config.captureLocation,
          captureRetention: String(data.config.captureRetention),
          captureMaxAgeDays: String(data.config.captureMaxAgeDays),
          captureMaxTotalMB: String(data.config.captureMaxTotalMB),
          rulers: data.config.rulers,
          takeover: data.config.takeover,
          takeoverLingerSeconds: (data.config.takeoverLingerMs / 1000).toString(),
          guardDangerous: data.config.guardDangerous,
          shell: data.config.shell,
          settleMs: String(data.config.settleMs)
        });
        setRuntime(data.runtime ?? null);
        setPhase('ready');
      }, []);

      const load = useCallback(async () => {
        setPhase('loading');
        setError(null);
        try {
          const data = await request('/state');
          if (!mounted.current) return;
          applyState(data);
        } catch (err) {
          if (!mounted.current) return;
          setError(errorText(err, t));
          setPhase('error');
        }
      }, [applyState, t]);

      useEffect(() => { load(); }, [load]);

      const update = useCallback((key, value) => {
        setForm((current) => current === null ? current : { ...current, [key]: value });
        setSavedFlash(false);
      }, []);

      const save = useCallback(async () => {
        if (form === null || phase === 'saving') return;
        setError(null);
        const patch = {
          captureLocation: form.captureLocation,
          rulers: form.rulers === true,
          takeover: form.takeover === true,
          guardDangerous: form.guardDangerous === true,
          shell: form.shell
        };
        const numeric = {};
        for (const [key, spec] of Object.entries(NUMERIC)) {
          const raw = String(form[key] ?? '').trim();
          const parsed = Number(raw);
          if (raw === '' || !Number.isFinite(parsed) || (spec.integer && !Number.isInteger(parsed)) || parsed < spec.min || parsed > spec.max) {
            setError(`${t('rangeError')} ${t(spec.labelKey)}（${spec.min}–${spec.max}）`);
            setPhase('error');
            return;
          }
          numeric[key] = parsed;
        }
        const linger = Number(String(form.takeoverLingerSeconds ?? '').trim());
        if (!Number.isFinite(linger) || linger < 0 || linger > 600) {
          setError(t('lingerError'));
          setPhase('error');
          return;
        }
        Object.assign(patch, numeric, { takeoverLingerMs: Math.round(linger * 1000) });

        setPhase('saving');
        try {
          await request('/config', { method: 'POST', body: { config: patch } });
          if (!mounted.current) return;
          setPhase('saved');
          setSavedFlash(true);
          setTimeout(() => { if (mounted.current) load(); }, 1600);
        } catch (err) {
          // The config editor restarts the plugin, which can drop the response. If
          // /state already shows the new values, the save did land.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await sleep(700);
            try {
              const data = await request('/state');
              const ok = data && data.config
                && data.config.captureLocation === patch.captureLocation
                && data.config.captureRetention === numeric.captureRetention
                && data.config.captureMaxAgeDays === numeric.captureMaxAgeDays
                && data.config.captureMaxTotalMB === numeric.captureMaxTotalMB
                && data.config.rulers === patch.rulers
                && data.config.takeover === patch.takeover
                && data.config.takeoverLingerMs === patch.takeoverLingerMs
                && data.config.guardDangerous === patch.guardDangerous
                && data.config.shell === patch.shell
                && data.config.settleMs === numeric.settleMs;
              if (ok) {
                if (!mounted.current) return;
                applyState(data);
                setPhase('saved');
                setSavedFlash(true);
                return;
              }
            } catch {
              // Still restarting; try again.
            }
          }
          if (!mounted.current) return;
          setError(errorText(err, t));
          setPhase('error');
        }
      }, [applyState, form, load, phase, t]);

      const disabled = phase === 'loading' || phase === 'saving';
      const status = phase === 'saving' ? t('saving') : (phase === 'saved' || savedFlash) ? t('saved') : '';

      if (form === null) {
        return h('div', { className: 'st-page' },
          h('style', null, CSS),
          h('header', { className: 'st-head' },
            h('span', { className: 'st-kicker' }, t('kicker')),
            h('h2', { className: 'st-title' }, t('title')),
            h('p', { className: 'st-sub' }, t('subtitle'))),
          h('p', { className: 'st-row-note' }, phase === 'error' ? t('loadFailed') : t('loading')),
          error ? h('div', { className: 'st-error', role: 'alert' },
            h('span', null, `${t('loadFailed')}：${error}`),
            h('button', { type: 'button', className: 'st-link', onClick: load }, t('retry'))) : null);
      }

      return h('div', { className: 'st-page' },
        h('style', null, CSS),
        h('header', { className: 'st-head' },
          h('span', { className: 'st-kicker' }, t('kicker')),
          h('h2', { className: 'st-title' }, t('title')),
          h('p', { className: 'st-sub' }, t('subtitle'))),

        // ---- eyes --------------------------------------------------------
        h('section', { className: 'st-card' },
          h('div', { className: 'st-card-head' },
            h('h3', { className: 'st-card-title' }, t('eyes')),
            h('span', { className: 'st-card-en' }, 'eyes')),
          h('div', { className: 'st-row' },
            h('span', { className: 'st-row-title' }, t('location')),
            h(Segmented, {
              value: form.captureLocation,
              disabled,
              options: [
                { id: 'temp', label: t('locationTemp') },
                { id: 'workspace', label: t('locationWorkspace') }
              ],
              onChange: (value) => update('captureLocation', value)
            }),
            h('p', { className: 'st-row-note' },
              form.captureLocation === 'workspace' ? t('locationWorkspaceNote') : t('locationTempNote'))),
          h('div', { className: 'st-row' },
            h('span', { className: 'st-row-title' }, t('retention')),
            h('div', { className: 'st-grid' },
              h(NumberBox, {
                label: t('keepCount'), value: form.captureRetention, min: 1, max: 500,
                unit: t('retentionUnit'), disabled, onChange: (value) => update('captureRetention', value)
              }),
              h(NumberBox, {
                label: t('maxAge'), value: form.captureMaxAgeDays, min: 0, max: 3650,
                unit: t('maxAgeUnit'), disabled, onChange: (value) => update('captureMaxAgeDays', value)
              }),
              h(NumberBox, {
                label: t('maxTotal'), value: form.captureMaxTotalMB, min: 0, max: 100000,
                unit: t('maxTotalUnit'), disabled, onChange: (value) => update('captureMaxTotalMB', value)
              })),
            h('p', { className: 'st-row-note' }, t('retentionNote'))),
          h('div', { className: 'st-row' },
            h(Toggle, {
              checked: form.rulers,
              disabled,
              title: t('rulers'),
              note: t('rulersNote'),
              onChange: (value) => update('rulers', value)
            }))),

        // ---- hands -------------------------------------------------------
        h('section', { className: 'st-card' },
          h('div', { className: 'st-card-head' },
            h('h3', { className: 'st-card-title' }, t('hands')),
            h('span', { className: 'st-card-en' }, 'hands')),
          h('div', { className: 'st-row' },
            h(Toggle, {
              checked: form.takeover,
              disabled,
              title: t('takeover'),
              note: t('takeoverNote'),
              onChange: (value) => update('takeover', value)
            }),
            h(NumberBox, {
              label: t('linger'), value: form.takeoverLingerSeconds, min: 0, max: 600, step: 0.5,
              unit: t('lingerUnit'), disabled, onChange: (value) => update('takeoverLingerSeconds', value)
            }),
            h('p', { className: 'st-row-note' }, t('lingerNote'))),
          h('div', { className: 'st-row' },
            h(Toggle, {
              checked: form.guardDangerous,
              disabled,
              title: t('guard'),
              note: t('guardNote'),
              badge: t('guardBadge'),
              onChange: (value) => update('guardDangerous', value)
            }))),

        // ---- engine ------------------------------------------------------
        h('section', { className: 'st-card' },
          h('div', { className: 'st-card-head' },
            h('h3', { className: 'st-card-title' }, t('engine')),
            h('span', { className: 'st-card-en' }, 'engine')),
          h('div', { className: 'st-row' },
            h('span', { className: 'st-row-title' }, t('shell')),
            h(Segmented, {
              value: form.shell,
              disabled,
              options: [
                { id: 'auto', label: t('shellAuto') },
                { id: 'pwsh', label: t('shellPwsh') },
                { id: 'powershell', label: t('shell51') }
              ],
              onChange: (value) => update('shell', value)
            }),
            h('p', { className: 'st-row-note' },
              form.shell === 'pwsh' ? t('shellPwshNote') : form.shell === 'powershell' ? t('shell51Note') : t('shellAutoNote')),
            runtime && runtime.shell ? h('div', { className: 'st-runtime' },
              h('b', null, `${t('resolved')}:`), h('span', null, runtime.shell)) : null),
          h('div', { className: 'st-row' },
            h(NumberBox, {
              label: t('settle'), value: form.settleMs, min: 0, max: 10000,
              unit: t('settleUnit'), disabled, onChange: (value) => update('settleMs', value)
            }),
            h('p', { className: 'st-row-note' }, t('settleNote'))),
          runtime && runtime.tempDir ? h('div', { className: 'st-runtime' },
            h('b', null, `${t('tempDir')}:`), h('span', null, runtime.tempDir)) : null),

        h('div', { className: 'st-actions' },
          h('button', {
            type: 'button',
            className: 'st-save',
            disabled: disabled,
            onClick: save
          }, phase === 'saving' ? t('saving') : t('save')),
          h('span', {
            className: 'st-status' + (phase === 'saving' ? ' is-pending' : ''),
            role: 'status',
            'aria-live': 'polite'
          }, status)),

        error
          ? h('div', { className: 'st-error', role: 'alert' },
            h('span', null, `${phase === 'error' && form === null ? t('loadFailed') : t('saveFailed')}：${error}`),
            h('button', { type: 'button', className: 'st-link', onClick: phase === 'error' && form === null ? load : save }, t('retry')))
          : null,

        h('p', { className: 'st-foot' }, t('foot')));
    }

    /* -------------------------------------------------------------- */
    /* Plugin                                                         */
    /* -------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'see-touch: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'see-touch',
          order: 34,
          label: () => t('nav')
        }, () => h(SettingsPage, { t })));

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'see-touch'
        }, (owner = {}) => h(NavIcon, { size: owner.size ?? 16 })));
      }
    };
  }
});

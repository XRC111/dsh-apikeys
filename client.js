window.__ModuleLoader__.load({
  id: 'dsh-apikeys-plugin',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const BRIDGE = '/api/dsh-apikeys';
    const NS = 'dsh-apikeys';

    const DICT = {
      zh: {
        'section.title': 'API Keys',
        'section.subtitle': '把一个或多个平台的 API Key 存在 DSH 凭据库，模型即可用你的身份调用它们的 API。',
        'row.summary': '多平台 API Key 管理 · apikey_call / apikey_platforms / apikey_key',
        'state.loading': '读取中…',
        'state.unreachable': '无法访问 Key 桥接（Host 半没有加载，或版本不匹配）。',
        'state.retry': '重试',
        'state.empty': '没有启用任何平台。在 cordis.patch.yml 里配置 enabledPlatforms。',
        'platform.select': '平台',
        'platform.default': '默认平台',
        'platform.custom': '自定义',
        'account.select': '账号',
        'account.default': '默认',
        'account.configured': '已配置',
        'account.unset': '未配置',
        'account.new': '新账号名',
        'account.add': '新增账号',
        'account.remove.hint': '账号无法删除，只能清除它的 Key。',
        'key.label': 'Key',
        'key.placeholder': '粘贴 API Key',
        'key.save': '保存',
        'key.saving': '保存中…',
        'key.clear': '清除',
        'key.verify': '验证',
        'key.verifying': '验证中…',
        'key.stored': '已保存到凭据库',
        'key.hint': 'Key 存放在 DSH 凭据库：不写进配置文件，也不进入会话日志。',
        'key.need': '请填写一个非空的 Key。',
        'key.noVerify': '该平台没有配置验证端点。',
        'link.docs': '获取 Key',
        'verified.as': '验证通过：{identity}',
        'verified.ok': '验证通过',
        'error.prefix': '出错：',
        'invalid.name': '账号名只能用小写字母和数字，以字母开头，不超过 32 位',
        'env.title': '环境变量回退',
        'env.on': '默认账号未存 Key 时使用 {name}',
        'env.off': '无',
        'expose.title': '向模型开放 Key',
        'expose.on': '开：apikey_key get 可返回 Key',
        'expose.off': '关：Key 只在 Host 内使用',
        'tools.title': '模型可用工具',
        'tools.call': 'apikey_call — 调用某平台 API（只能走该平台主机）',
        'tools.platforms': 'apikey_platforms — 列出平台与账号状态（不含 Key）',
        'tools.key': 'apikey_key — 读取 / 写入 / 清除某个 Key',
        'note.docs': '文档',
      },
      en: {
        'section.title': 'API Keys',
        'section.subtitle': 'Store API keys for one or more platforms in the DSH credential store, so the model can call their APIs as you.',
        'row.summary': 'Multi-platform API keys · apikey_call / apikey_platforms / apikey_key',
        'state.loading': 'Loading…',
        'state.unreachable': 'Cannot reach the key bridge (Host half missing or out of step).',
        'state.retry': 'Retry',
        'state.empty': 'No platform is enabled. Set enabledPlatforms in cordis.patch.yml.',
        'platform.select': 'Platform',
        'platform.default': 'default platform',
        'platform.custom': 'custom',
        'account.select': 'Account',
        'account.default': 'default',
        'account.configured': 'configured',
        'account.unset': 'not configured',
        'account.new': 'New account name',
        'account.add': 'Add account',
        'account.remove.hint': 'Accounts cannot be removed; clear the key instead.',
        'key.label': 'Key',
        'key.placeholder': 'Paste an API key',
        'key.save': 'Save',
        'key.saving': 'Saving…',
        'key.clear': 'Clear',
        'key.verify': 'Verify',
        'key.verifying': 'Verifying…',
        'key.stored': 'Stored in the credential store',
        'key.hint': 'The key lives in the DSH credential store: never in configuration, never in the session log.',
        'key.need': 'Enter a non-empty key.',
        'key.noVerify': 'This platform declares no verification endpoint.',
        'link.docs': 'Get a key',
        'verified.as': 'verified as {identity}',
        'verified.ok': 'verified',
        'error.prefix': 'Error: ',
        'invalid.name': 'account names are lowercase letters and digits, starting with a letter, at most 32',
        'env.title': 'Environment fallback',
        'env.on': 'Uses {name} while the default account has no stored key',
        'env.off': 'none',
        'expose.title': 'Expose keys to the model',
        'expose.on': 'On: apikey_key get returns the key',
        'expose.off': 'Off: the key stays inside the Host',
        'tools.title': 'Tools the model can call',
        'tools.call': 'apikey_call — call one platform API (its own host only)',
        'tools.platforms': 'apikey_platforms — list platforms and account state (no values)',
        'tools.key': 'apikey_key — get / set / clear one key',
        'note.docs': 'Docs',
      },
    };

    const CSS = `
.dak-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;min-width:0;box-sizing:border-box}
.dak-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.dak-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.dak-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;flex:1 1 240px;min-width:0}
.dak-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.dak-label{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;min-width:56px}
.dak-chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0;align-items:center}
.dak-chip{font:inherit;font-size:12px;line-height:20px;cursor:pointer;border-radius:999px;padding:1px 11px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);transition:border-color 150ms ease,color 150ms ease,background-color 150ms ease}
.dak-chip:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.dak-chip[data-active="true"]{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);color:var(--dsw-alias-label-primary)}
.dak-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:var(--dsw-alias-state-idle-primary);vertical-align:middle}
.dak-chip[data-configured="true"] .dak-dot{background:var(--dsw-alias-state-success-primary)}
.dak-input{font:inherit;font-size:13px;min-width:0;flex:1 1 220px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}
.dak-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dak-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dak-btn{font:inherit;font-size:12px;line-height:20px;cursor:pointer;border-radius:8px;padding:4px 13px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);transition:border-color 150ms ease,opacity 150ms ease}
.dak-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary)}
.dak-btn:disabled{opacity:.45;cursor:default}
.dak-btn[data-kind="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dak-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}
.dak-badge{flex:none;border-radius:999px;padding:1px 9px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dak-badge[data-on="true"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}
.dak-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.dak-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dak-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dak-panel{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.dak-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dak-facts b{color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere}
.dak-tools{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dak-tools li{margin:2px 0}
.dak-link{color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none}
.dak-link:hover{text-decoration:underline}
`;

    /** Translate through one dictionary, with `{name}` placeholders. */
    function makeT(localeId) {
      const dict = String(localeId || '').toLowerCase().startsWith('en') ? DICT.en : DICT.zh;
      return (key, vars) => {
        const template = dict[key] || DICT.zh[key] || key;
        if (!vars) return template;
        return template.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
      };
    }

    /** One POST to the Host bridge; never throws, so a lost Host half degrades to a message. */
    async function callBridge(route, body) {
      let response;
      try {
        response = await fetch(`${BRIDGE}/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
      } catch (error) {
        return { ok: false, code: 'network', message: String((error && error.message) || error) };
      }
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.message === 'string') message = payload.message;
        } catch {
          // keep the status text
        }
        return { ok: false, code: 'http', message };
      }
      try {
        return await response.json();
      } catch {
        return { ok: false, code: 'bad-json', message: 'the bridge answered with something other than JSON' };
      }
    }

    /** Render one platform's account list plus the active account's key controls. */
    function PlatformPanel(props) {
      const { platform, t, activeName, onSelectAccount, busy, note, onRun, refresh } = props;
      const active = platform.accounts.find((account) => account.name === activeName)
        || { name: activeName, configured: false, source: 'unset', isDefault: false };

      const [key, setKey] = React.useState('');
      const [newName, setNewName] = React.useState('');
      const [adding, setAdding] = React.useState(false);
      const [localNote, setLocalNote] = React.useState(null);

      const save = () => {
        const trimmed = key.trim();
        if (trimmed.length === 0) {
          setLocalNote({ tone: 'error', text: t('key.need') });
          return;
        }
        onRun('save', async () => {
          const reply = await callBridge('set', { platform: platform.id, account: activeName, token: trimmed });
          if (reply.ok === true) {
            setKey('');
            setLocalNote({ tone: 'ok', text: t('key.stored') });
            await refresh();
          } else {
            setLocalNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
          }
        });
      };

      const clearKey = () => onRun('clear', async () => {
        const reply = await callBridge('clear', { platform: platform.id, account: activeName });
        if (reply.ok === true) { setLocalNote(null); await refresh(); }
        else setLocalNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
      });

      const verify = () => onRun('verify', async () => {
        const reply = await callBridge('verify', { platform: platform.id, account: activeName });
        if (reply.ok === true) {
          const identity = reply.value && reply.value.identity;
          setLocalNote({
            tone: 'ok',
            text: identity === undefined ? t('verified.ok') : t('verified.as', { identity }),
          });
          await refresh();
        } else {
          setLocalNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
        }
      });

      const commitNewAccount = () => {
        const name = newName.trim().toLowerCase();
        if (!/^[a-z][a-z0-9]{0,31}$/.test(name)) {
          setLocalNote({ tone: 'error', text: t('invalid.name') });
          return;
        }
        setAdding(false);
        setNewName('');
        setLocalNote(null);
        onSelectAccount(name);
      };

      const shown = localNote ?? note;

      return h(
        'div',
        { className: 'dak-panel' },
        h('div', { className: 'dak-row' },
          h('span', { className: 'dak-label' }, t('account.select')),
          h('div', { className: 'dak-chips' },
            platform.accounts.map((account) => h('button', {
              key: account.name,
              className: 'dak-chip',
              type: 'button',
              'data-active': String(account.name === activeName),
              'data-configured': String(account.configured === true),
              title: account.configured ? `${account.name} · ${account.source}` : account.name,
              onClick: () => { onSelectAccount(account.name); setLocalNote(null); setAdding(false); },
            },
            h('span', { className: 'dak-dot' }),
            account.name,
            account.isDefault ? ` · ${t('account.default')}` : '')),
            adding
              ? h('input', {
                className: 'dak-input',
                value: newName,
                placeholder: t('account.new'),
                'aria-label': t('account.new'),
                onChange: (event) => setNewName(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitNewAccount(); },
              })
              : h('button', { className: 'dak-btn', type: 'button', onClick: () => setAdding(true) }, t('account.add')))),

        h('div', { className: 'dak-row' },
          h('span', { className: 'dak-label' }, t('key.label')),
          h('input', {
            className: 'dak-input',
            type: 'password',
            value: key,
            placeholder: t('key.placeholder'),
            'aria-label': t('key.label'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setKey(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') save(); },
          }),
          h('button', {
            className: 'dak-btn', 'data-kind': 'primary', type: 'button', disabled: busy !== 'idle', onClick: save,
          }, busy === 'save' ? t('key.saving') : t('key.save')),
          h('button', {
            className: 'dak-btn', type: 'button', disabled: busy !== 'idle' || active.configured !== true, onClick: verify,
          }, busy === 'verify' ? t('key.verifying') : t('key.verify')),
          h('button', {
            className: 'dak-btn', 'data-kind': 'danger', type: 'button',
            disabled: busy !== 'idle' || active.configured !== true, onClick: clearKey,
          }, t('key.clear'))),

        shown === null ? null : h('p', {
          className: 'dak-note',
          'data-tone': shown.tone === 'ok' ? 'ok' : 'error',
        }, shown.tone === 'ok' ? shown.text : `${t('error.prefix')}${shown.text}`),

        active.configured && active.source && active.source !== 'stored'
          ? h('p', { className: 'dak-note' }, `${t('env.title')}: ${active.source}`)
          : null,

        platform.envName === undefined
          ? null
          : h('p', { className: 'dak-note' }, t('env.on', { name: platform.envName })),
      );
    }

    /** The whole management surface: platform chips, then the selected platform's panel. */
    function ApiKeysPanel(props) {
      const t = makeT(props.localeId);
      const pageMode = props.view === 'page';
      const [state, setState] = React.useState({ status: 'loading' });
      const [platformId, setPlatformId] = React.useState(null);
      const [accountName, setAccountName] = React.useState(null);
      const [busy, setBusy] = React.useState('idle');
      const [note, setNote] = React.useState(null);

      const load = React.useCallback(async () => {
        const reply = await callBridge('status');
        if (reply.ok !== true) {
          setState({ status: 'unreachable', message: reply.message || '' });
          return;
        }
        const value = reply.value || {};
        const platforms = Array.isArray(value.platforms) ? value.platforms : [];
        setState({ status: 'ready', value, platforms });
        setPlatformId((current) => {
          if (current && platforms.some((entry) => entry.id === current)) return current;
          const fallback = platforms.find((entry) => entry.id === value.defaultPlatform) || platforms[0];
          return fallback ? fallback.id : null;
        });
        setAccountName((current) => current ?? String(value.defaultAccount || 'default'));
      }, []);

      React.useEffect(() => {
        if (pageMode) load();
      }, [pageMode, load]);

      if (!pageMode) return h('span', null, t('row.summary'));

      if (state.status === 'loading') {
        return h('div', { className: 'dak-card' }, h('p', { className: 'dak-note' }, t('state.loading')));
      }

      if (state.status === 'unreachable') {
        return h(
          'div',
          { className: 'dak-card' },
          h('p', { className: 'dak-note', 'data-tone': 'error' }, t('state.unreachable')),
          state.message ? h('p', { className: 'dak-note' }, state.message) : null,
          h('div', { className: 'dak-row' },
            h('button', {
              className: 'dak-btn', type: 'button',
              onClick: () => { setState({ status: 'loading' }); load(); },
            }, t('state.retry'))),
        );
      }

      const value = state.value || {};
      const platforms = state.platforms || [];
      if (platforms.length === 0) {
        return h('div', { className: 'dak-card' },
          h('p', { className: 'dak-title' }, t('section.title')),
          h('p', { className: 'dak-note' }, t('state.empty')));
      }

      const activePlatform = platforms.find((entry) => entry.id === platformId) || platforms[0];
      const activeAccount = accountName ?? String(value.defaultAccount || 'default');
      const activeRow = (activePlatform.accounts || []).find((account) => account.name === activeAccount);
      const configured = activeRow !== undefined && activeRow.configured === true;

      const run = (kind, action) => {
        setBusy(kind);
        setNote(null);
        Promise.resolve()
          .then(action)
          .catch((error) => setNote({ tone: 'error', text: String((error && error.message) || error) }))
          .then(() => setBusy('idle'));
      };

      return h(
        'div',
        { className: 'dak-card' },
        h('div', { className: 'dak-head' },
          h('h3', { className: 'dak-title' }, t('section.title')),
          h('p', { className: 'dak-sub' }, t('section.subtitle')),
          h('span', { className: 'dak-badge', 'data-on': String(configured) },
            configured ? t('account.configured') : t('account.unset')),
          activePlatform.id === value.defaultPlatform
            ? h('span', { className: 'dak-badge' }, t('platform.default'))
            : null,
          activePlatform.custom
            ? h('span', { className: 'dak-badge' }, t('platform.custom'))
            : null),

        h('div', { className: 'dak-row' },
          h('span', { className: 'dak-label' }, t('platform.select')),
          h('div', { className: 'dak-chips' },
            platforms.map((platform) => {
              const anyConfigured = (platform.accounts || []).some((account) => account.configured === true);
              return h('button', {
                key: platform.id,
                className: 'dak-chip',
                type: 'button',
                'data-active': String(platform.id === activePlatform.id),
                'data-configured': String(anyConfigured),
                onClick: () => { setPlatformId(platform.id); setNote(null); },
              },
              h('span', { className: 'dak-dot' }),
              platform.label);
            }))),

        h(PlatformPanel, {
          // Remount the panel when the platform changes so its local state resets.
          key: activePlatform.id,
          platform: activePlatform,
          activeName: activeAccount,
          onSelectAccount: (name) => { setAccountName(name); setNote(null); },
          busy,
          note,
          onRun: run,
          refresh: load,
          t,
        }),

        activePlatform.docs
          ? h('p', { className: 'dak-note' },
            h('a', {
              className: 'dak-link', href: activePlatform.docs, target: '_blank', rel: 'noreferrer',
            }, t('link.docs')))
          : null,
        activePlatform.hint ? h('p', { className: 'dak-note' }, activePlatform.hint) : null,
        activePlatform.note ? h('p', { className: 'dak-note' }, activePlatform.note) : null,

        h('p', { className: 'dak-note' }, t('key.hint')),

        h('div', { className: 'dak-facts' },
          h('span', null, t('expose.title')),
          h('b', null, value.exposeKeys ? t('expose.on') : t('expose.off')),
          h('span', null, t('env.title')),
          h('b', null, value.envFallback ? t('env.on', { name: activePlatform.envName || '—' }) : t('env.off'))),

        h('div', null,
          h('p', { className: 'dak-note' }, t('tools.title')),
          h('ul', { className: 'dak-tools' },
            h('li', null, t('tools.call')),
            h('li', null, t('tools.platforms')),
            h('li', null, t('tools.key')))),
      );
    }

    /** Render one slot entry with the live locale id read from the Client locale service. */
    function withLocale(ctx, render) {
      return (slotProps) => {
        const locale = ctx.get('locale');
        let localeId = 'zh';
        if (locale !== undefined && typeof locale.getLocale === 'function') {
          try {
            localeId = String(locale.getLocale().active || 'zh');
          } catch {
            localeId = 'zh';
          }
        }
        return render(slotProps, localeId);
      };
    }

    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = NS;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          if (style.parentNode !== null) style.parentNode.removeChild(style);
        };
      }, 'dsh-apikeys: styles');

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-apikeys-plugin#apikeys',
      }, withLocale(ctx, (slotProps, localeId) => h(ApiKeysPanel, {
        view: slotProps && slotProps.view === 'page' ? 'page' : 'summary',
        localeId,
      }))));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'apikeys',
        order: 34,
        label: () => 'API Keys',
      }, withLocale(ctx, (_slotProps, localeId) => h(ApiKeysPanel, { view: 'page', localeId }))));
    };

    exports.inject = ['slots'];

    return exports;
  },
});

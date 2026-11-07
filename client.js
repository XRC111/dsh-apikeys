window.__ModuleLoader__.load({
  id: 'dsh-github-plugin',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const BRIDGE = '/api/dsh-github';
    const NS = 'dsh-github';

    const DICT = {
      zh: {
        'section.title': 'GitHub',
        'section.subtitle': '管理 GitHub API Token，让模型用自己的身份调用 GitHub。',
        'row.summary': 'GitHub API Token · github_api / github_key',
        'state.loading': '读取中…',
        'state.unreachable': '无法访问 GitHub 凭据桥接（Host 半没有加载，或版本不匹配）。',
        'state.retry': '重试',
        'account.select': '账号',
        'account.default': '默认',
        'account.configured': '已配置',
        'account.unset': '未配置',
        'account.new': '新账号名',
        'account.add': '新增账号',
        'token.label': 'Token',
        'token.placeholder': '粘贴 Personal Access Token',
        'token.save': '保存',
        'token.saving': '保存中…',
        'token.clear': '清除',
        'token.verify': '验证',
        'token.verifying': '验证中…',
        'token.stored': '已保存到凭据库',
        'token.hint': 'Token 存放在 DSH 凭据库：不写进配置文件，也不进入会话日志。',
        'token.need': '请填写一个带 repo 权限的 personal access token。',
        'link.create': '在 GitHub 上创建 Token',
        'verified.as': '已验证为 {login}',
        'error.prefix': '出错：',
        'env.title': '环境变量回退',
        'env.on': '未保存 Token 时使用 {name}',
        'env.off': '已关闭',
        'expose.title': '向模型开放 Token',
        'expose.on': '开：github_key get 可以返回 Token',
        'expose.off': '关：Token 只在 Host 内使用',
        'host.title': 'API 主机',
        'tools.title': '模型可用工具',
        'tools.api': 'github_api — 调用任意 GitHub REST 接口',
        'tools.accounts': 'github_accounts — 列出账号与配置状态（不含 Token）',
        'tools.key': 'github_key — get / set / clear 某个账号的 Token',
        'invalid.name': '账号名只能用小写字母、数字和连字符，并以字母开头',
      },
      en: {
        'section.title': 'GitHub',
        'section.subtitle': 'Manage GitHub API tokens so the model can act as you on GitHub.',
        'row.summary': 'GitHub API tokens · github_api / github_key',
        'state.loading': 'Loading…',
        'state.unreachable': 'Cannot reach the GitHub credential bridge (Host half missing or out of step).',
        'state.retry': 'Retry',
        'account.select': 'Account',
        'account.default': 'default',
        'account.configured': 'configured',
        'account.unset': 'not configured',
        'account.new': 'New account name',
        'account.add': 'Add account',
        'token.label': 'Token',
        'token.placeholder': 'Paste a personal access token',
        'token.save': 'Save',
        'token.saving': 'Saving…',
        'token.clear': 'Clear',
        'token.verify': 'Verify',
        'token.verifying': 'Verifying…',
        'token.stored': 'Stored in the credential store',
        'token.hint': 'The token lives in the DSH credential store: never in configuration, never in the session log.',
        'token.need': 'Use a personal access token with repository scope.',
        'link.create': 'Create a token on GitHub',
        'verified.as': 'verified as {login}',
        'error.prefix': 'Error: ',
        'env.title': 'Environment fallback',
        'env.on': 'Uses {name} while no token is stored',
        'env.off': 'Off',
        'expose.title': 'Expose tokens to the model',
        'expose.on': 'On: github_key get returns the token',
        'expose.off': 'Off: the token stays inside the Host',
        'host.title': 'API host',
        'tools.title': 'Tools the model can call',
        'tools.api': 'github_api — call any GitHub REST endpoint',
        'tools.accounts': 'github_accounts — list accounts and their state (no values)',
        'tools.key': 'github_key — get / set / clear one account token',
        'invalid.name': 'account names are lowercase letters, digits and dashes, starting with a letter',
      },
    };

    const CSS = `
.dgh-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;min-width:0;box-sizing:border-box}
.dgh-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.dgh-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.dgh-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;flex:1 1 240px;min-width:0}
.dgh-badge{flex:none;border-radius:999px;padding:1px 9px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dgh-badge[data-on="true"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}
.dgh-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.dgh-label{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;min-width:56px}
.dgh-accounts{display:flex;flex-wrap:wrap;gap:6px;min-width:0;align-items:center}
.dgh-chip{font:inherit;font-size:12px;line-height:20px;cursor:pointer;border-radius:999px;padding:1px 11px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);transition:border-color 150ms ease,color 150ms ease,background-color 150ms ease}
.dgh-chip:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.dgh-chip[data-active="true"]{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);color:var(--dsw-alias-label-primary)}
.dgh-chip-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:var(--dsw-alias-state-idle-primary);vertical-align:middle}
.dgh-chip[data-configured="true"] .dgh-chip-dot{background:var(--dsw-alias-state-success-primary)}
.dgh-input{font:inherit;font-size:13px;min-width:0;flex:1 1 220px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}
.dgh-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.dgh-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dgh-btn{font:inherit;font-size:12px;line-height:20px;cursor:pointer;border-radius:8px;padding:4px 13px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);transition:border-color 150ms ease,opacity 150ms ease}
.dgh-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary)}
.dgh-btn:disabled{opacity:.45;cursor:default}
.dgh-btn[data-kind="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dgh-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}
.dgh-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.dgh-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dgh-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dgh-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dgh-facts b{color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere}
.dgh-tools{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dgh-tools li{margin:2px 0}
.dgh-link{color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none}
.dgh-link:hover{text-decoration:underline}
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

    /**
     * The management surface. It renders on the plugin's own configuration page
     * (`view: 'page'`) and, as a one-line summary, wherever the slot asks for
     * `view: 'summary'`.
     */
    function GithubPanel(props) {
      const t = makeT(props.localeId);
      const pageMode = props.view === 'page';
      const [state, setState] = React.useState({ status: 'loading' });
      const [selected, setSelected] = React.useState('');
      const [token, setToken] = React.useState('');
      const [busy, setBusy] = React.useState('idle');
      const [note, setNote] = React.useState(null);
      const [newName, setNewName] = React.useState('');
      const [adding, setAdding] = React.useState(false);

      const load = React.useCallback(async () => {
        const reply = await callBridge('status');
        if (reply.ok !== true) {
          setState({ status: 'unreachable', message: reply.message || '' });
          return;
        }
        const value = reply.value || {};
        const accounts = Array.isArray(value.accounts) ? value.accounts : [];
        setState({ status: 'ready', value, accounts });
        setSelected((current) => {
          if (current && accounts.some((account) => account.name === current)) return current;
          const fallback = accounts.find((account) => account.isDefault) || accounts[0];
          return fallback ? fallback.name : String(value.defaultAccount || 'default');
        });
      }, []);

      React.useEffect(() => {
        if (pageMode) load();
      }, [pageMode, load]);

      if (!pageMode) return h('span', null, t('row.summary'));

      if (state.status === 'loading') {
        return h('div', { className: 'dgh-card' }, h('p', { className: 'dgh-note' }, t('state.loading')));
      }

      if (state.status === 'unreachable') {
        return h(
          'div',
          { className: 'dgh-card' },
          h('p', { className: 'dgh-note', 'data-tone': 'error' }, t('state.unreachable')),
          state.message ? h('p', { className: 'dgh-note' }, state.message) : null,
          h('div', { className: 'dgh-row' },
            h('button', {
              className: 'dgh-btn',
              type: 'button',
              onClick: () => { setState({ status: 'loading' }); load(); },
            }, t('state.retry'))),
        );
      }

      const value = state.value || {};
      const accounts = state.accounts || [];
      const activeName = selected || String(value.defaultAccount || 'default');
      const active = accounts.find((account) => account.name === activeName)
        || { name: activeName, configured: false, source: 'unset', isDefault: false };

      const run = (kind, action) => {
        setBusy(kind);
        setNote(null);
        Promise.resolve()
          .then(action)
          .catch((error) => setNote({ tone: 'error', text: String((error && error.message) || error) }))
          .then(() => setBusy('idle'));
      };

      const save = () => {
        const trimmed = token.trim();
        if (trimmed.length === 0) {
          setNote({ tone: 'error', text: t('token.need') });
          return;
        }
        run('save', async () => {
          const reply = await callBridge('set', { account: activeName, token: trimmed });
          if (reply.ok === true) {
            setToken('');
            setNote({ tone: 'ok', text: t('token.stored') });
            await load();
          } else {
            setNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
          }
        });
      };

      const clearToken = () => run('clear', async () => {
        const reply = await callBridge('clear', { account: activeName });
        if (reply.ok === true) await load();
        else setNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
      });

      const verify = () => run('verify', async () => {
        const reply = await callBridge('verify', { account: activeName });
        if (reply.ok === true) {
          const login = reply.value && reply.value.login;
          setNote({ tone: 'ok', text: t('verified.as', { login: login || 'GitHub' }) });
          await load();
        } else {
          setNote({ tone: 'error', text: reply.message || reply.code || 'failed' });
        }
      });

      const commitNewAccount = () => {
        const name = newName.trim().toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(name)) {
          setNote({ tone: 'error', text: t('invalid.name') });
          return;
        }
        setSelected(name);
        setAdding(false);
        setNewName('');
        setNote(null);
      };

      return h(
        'div',
        { className: 'dgh-card' },
        h('div', { className: 'dgh-head' },
          h('h3', { className: 'dgh-title' }, t('section.title')),
          h('p', { className: 'dgh-sub' }, t('section.subtitle')),
          h('span', { className: 'dgh-badge', 'data-on': String(active.configured === true) },
            active.configured ? t('account.configured') : t('account.unset'))),

        h('div', { className: 'dgh-row' },
          h('span', { className: 'dgh-label' }, t('account.select')),
          h('div', { className: 'dgh-accounts' },
            accounts.map((account) => h('button', {
              key: account.name,
              className: 'dgh-chip',
              type: 'button',
              'data-active': String(account.name === activeName),
              'data-configured': String(account.configured === true),
              title: account.configured ? `${account.name} · ${account.source}` : account.name,
              onClick: () => { setSelected(account.name); setNote(null); setAdding(false); },
            },
            h('span', { className: 'dgh-chip-dot' }),
            account.name,
            account.isDefault ? ` · ${t('account.default')}` : '')),
            adding
              ? h('input', {
                className: 'dgh-input',
                value: newName,
                placeholder: t('account.new'),
                'aria-label': t('account.new'),
                onChange: (event) => setNewName(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitNewAccount(); },
              })
              : h('button', { className: 'dgh-btn', type: 'button', onClick: () => setAdding(true) }, t('account.add')))),

        h('div', { className: 'dgh-row' },
          h('span', { className: 'dgh-label' }, t('token.label')),
          h('input', {
            className: 'dgh-input',
            type: 'password',
            value: token,
            placeholder: t('token.placeholder'),
            'aria-label': t('token.label'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setToken(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') save(); },
          }),
          h('button', {
            className: 'dgh-btn', 'data-kind': 'primary', type: 'button', disabled: busy !== 'idle', onClick: save,
          }, busy === 'save' ? t('token.saving') : t('token.save')),
          h('button', {
            className: 'dgh-btn', type: 'button', disabled: busy !== 'idle' || active.configured !== true, onClick: verify,
          }, busy === 'verify' ? t('token.verifying') : t('token.verify')),
          h('button', {
            className: 'dgh-btn', 'data-kind': 'danger', type: 'button',
            disabled: busy !== 'idle' || active.configured !== true, onClick: clearToken,
          }, t('token.clear'))),

        h('p', { className: 'dgh-note' }, t('token.hint')),
        h('p', { className: 'dgh-note' },
          h('a', {
            className: 'dgh-link',
            href: 'https://github.com/settings/tokens',
            target: '_blank',
            rel: 'noreferrer',
          }, t('link.create'))),

        note === null ? null : h('p', {
          className: 'dgh-note',
          'data-tone': note.tone === 'ok' ? 'ok' : 'error',
        }, note.tone === 'ok' ? note.text : `${t('error.prefix')}${note.text}`),

        active.configured && active.source && active.source !== 'stored'
          ? h('p', { className: 'dgh-note' }, `${active.source}`)
          : null,

        h('div', { className: 'dgh-facts' },
          h('span', null, t('host.title')),
          h('b', null, String(value.baseUrl || 'https://api.github.com')),
          h('span', null, t('env.title')),
          h('b', null, value.envFallback ? t('env.on', { name: String(value.envName || 'GITHUB_TOKEN') }) : t('env.off')),
          h('span', null, t('expose.title')),
          h('b', null, value.exposeKeys ? t('expose.on') : t('expose.off'))),

        h('div', null,
          h('p', { className: 'dgh-note' }, t('tools.title')),
          h('ul', { className: 'dgh-tools' },
            h('li', null, t('tools.api')),
            h('li', null, t('tools.accounts')),
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

    exports.apply = function apply(ctx) {      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = NS;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          if (style.parentNode !== null) style.parentNode.removeChild(style);
        };
      }, 'dsh-github: styles');

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-github-plugin#github-tools',
      }, withLocale(ctx, (slotProps, localeId) => h(GithubPanel, {
        view: slotProps && slotProps.view === 'page' ? 'page' : 'summary',
        localeId,
      }))));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'github',
        order: 34,
        label: () => 'GitHub',
      }, withLocale(ctx, (_slotProps, localeId) => h(GithubPanel, { view: 'page', localeId }))));
    };

    exports.inject = ['slots'];

    return exports;
  },
});

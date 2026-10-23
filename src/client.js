window.__ModuleLoader__.load({ id: 'dsh-agent-hub', factory: (require) => {
  const React = require('react')
  const h = React.createElement
  const errors = {
    'invalid-pair-code': '配对码已过期、已使用或不正确，请在主机重新生成。',
    'already-paired-use-replace-explicitly': '设备已经配对。需要更换主机时请勾选重新配对。',
    'runtime-has-active-tasks': '有任务正在运行或等待核查，请处理完毕后再修改。',
    'device-unpaired': '主机已撤销设备绑定，请重新配对。',
    'invalid-unpair-receipt': '未取得有效解绑回执，已保留本机绑定，请重试。',
    'select-existing-weixin-synced-session': '请选择该微信目标实际绑定的会话，并在 DSH-IM 中开启会话同步。',
    'master-not-running': '主机服务尚未就绪，请检查微信插件和运行状态。',
    'worker-already-running-or-owner-unverifiable': '已有外部 Worker。修改配对前请先正常退出它。',
    'worker-owner-unverifiable': '无法确认已有 Worker 的归属，已停止自动启动，请核查原进程。',
    'harness-unavailable': 'Harness 会话桥接尚未连接，请稍后刷新。',
    'offline': '设备尚未连接主机，请检查地址、网络和主机运行状态。',
    'communication-timeout': '通信检查超时，请检查网络连接。',
    'ECONNREFUSED': '连接被拒绝，请检查主机地址、端口和服务状态。',
    'ENOENT': '未找到指定目录或可执行文件，请检查本机路径。',
    'DEPTH_ZERO_SELF_SIGNED_CERT': '主机证书不受信任，请提供正确的公开证书。',
    'ERR_TLS_CERT_ALTNAME_INVALID': '主机地址与证书不匹配，请核对 IP 或域名。',
    'https-required': '公网连接请使用 https:// 地址。',
    'unknown-runtime': '该执行入口未启用。',
    'invalid-runtimes': '此插件只提供 Harness 执行入口。'
    , 'harness-only-use-local-subagent': '请派发给 Harness，由对应机器的 Harness 通过本地 sub agent 调用 Codex。'
    , 'legacy-runtime-tasks-require-review': '旧执行入口还有未结束的任务，请先在原机器核查，迁移不会自动重跑。',
    'worker-profile-does-not-provide-harness': '此目录属于独立 Codex Worker，请在连接设置中选择 Harness 专用数据目录。',
    'worker-not-running-or-starting': 'Worker 尚未就绪，请稍后重试。',
  }
  const friendly = (error) => { const code = typeof error === 'string' ? error : error?.code || error?.message || 'runtime-error'; return errors[code] || `操作未完成（${code}）` }
  const labels = { setup: '待配置', starting: '启动中', waiting_im: '等待微信插件', running: '运行中', error: '启动异常', managed: '插件托管', external: '外部 Worker', waiting_binding: '等待配对', stopped: '已停止' }
  const field = (label, control, hint) => h('label', { className: 'ah-field' }, h('span', null, label), control, hint && h('small', null, hint))
  const badge = (text, good) => h('span', { className: 'ah-badge ' + (good ? 'ah-good' : 'ah-muted') }, h('i'), text)
  const input = (value, set, props = {}) => h('input', { value, onChange: (event) => set(event.target.value), ...props })
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN') : '暂无记录'
  const css = `
.ah-page{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;max-width:1120px;margin:auto;padding:28px 28px 60px;box-sizing:border-box;container-type:inline-size}
.ah-page *{box-sizing:border-box}.ah-page button,.ah-page input,.ah-page select,.ah-page textarea{font:inherit}.ah-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.ah-kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#72859c}.ah-page h1{font-size:25px;margin:5px 0 4px;letter-spacing:-.5px}.ah-page h2{font-size:16px;margin:0 0 16px}.ah-page p{margin:6px 0;color:#728197}.ah-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.ah-card{border:1px solid rgba(125,145,167,.22);border-radius:14px;padding:22px;background:rgba(128,145,166,.055);margin-bottom:18px}.ah-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}.ah-stat{border:1px solid rgba(125,145,167,.20);background:rgba(134,164,197,.045);border-radius:12px;padding:16px}.ah-stat small{display:block;color:#7a8798}.ah-stat strong{display:block;font-size:20px;margin-top:6px;font-weight:650}.ah-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:5px 10px;border-radius:50px;white-space:nowrap}.ah-badge i{width:6px;height:6px;border-radius:50%;background:currentColor}.ah-good{color:#16866a;background:rgba(22,134,106,.09)}.ah-muted{color:#8a7c4c;background:rgba(170,144,60,.10)}.ah-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ah-split{display:flex;align-items:center;justify-content:space-between;gap:12px}.ah-page button{cursor:pointer;border:1px solid rgba(116,138,163,.28);background:transparent;border-radius:8px;padding:8px 13px;color:inherit;font-weight:550}.ah-page button:hover{background:rgba(123,152,184,.08)}.ah-page button:disabled{opacity:.45;cursor:default}.ah-page button.ah-primary{color:white;background:#3275b9;border-color:#3275b9}.ah-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}.ah-field>span{font-size:12px;font-weight:600;color:#718094}.ah-field small{font-size:11px;color:#8d99aa}.ah-page input:not([type=checkbox]),.ah-page select,.ah-page textarea{width:100%;min-width:0;border:1px solid rgba(116,138,163,.28);border-radius:8px;background:transparent;color:inherit;padding:9px 11px;outline:none}.ah-page input:focus,.ah-page select:focus,.ah-page textarea:focus{border-color:#3275b9}.ah-page textarea{font-family:ui-monospace,monospace;font-size:11px;resize:vertical}.ah-note{font-size:12px;color:#8290a2;margin-top:13px}.ah-notice{border-radius:9px;padding:12px 15px;margin-bottom:18px;border:1px solid rgba(22,134,106,.18);background:rgba(22,134,106,.06);color:#16866a}.ah-error{background:rgba(191,75,75,.06);border-color:rgba(191,75,75,.25);color:#b84d4d}.ah-empty{text-align:center;padding:26px;color:#8290a2;border:1px dashed rgba(125,145,167,.25);border-radius:10px}.ah-code{font:700 30px/1.8 ui-monospace,monospace;letter-spacing:4px;color:#3275b9;overflow-wrap:anywhere}.ah-device{border:1px solid rgba(125,145,167,.2);border-radius:10px;padding:16px;margin-top:12px}.ah-endpoint{border-top:1px solid rgba(125,145,167,.13);padding-top:11px;margin-top:12px}.ah-page code{font-size:11px;word-break:break-all;color:#75869b}.ah-subtle{color:#8b96a6;font-size:12px}.ah-check{display:flex;align-items:center;gap:7px}.ah-page details{margin:10px 0}.ah-page summary{cursor:pointer;color:#7e8c9d;font-size:12px}.ah-wide{grid-column:1/-1}.ah-choices{display:flex;gap:12px;margin-bottom:16px}.ah-choices button{padding:18px 24px;text-align:left;min-width:200px}.ah-session-row{margin-top:15px;padding-top:15px;border-top:1px solid rgba(125,145,167,.18)}.ah-page a{color:#3275b9}@media(max-width:760px){.ah-page{padding:18px 14px}.ah-grid{grid-template-columns:1fr}.ah-stats{grid-template-columns:1fr}.ah-top{flex-wrap:wrap}.ah-choices{flex-wrap:wrap}}
@container(max-width:620px){.ah-grid{grid-template-columns:1fr}.ah-stats{gap:8px}.ah-stat{padding:12px}.ah-stat strong{font-size:16px}.ah-top{flex-wrap:wrap}}
.ah-page select option{background:Canvas;color:CanvasText}
`

  function SessionBinding({ endpoint, sessions, run, busy }) {
    const [selected, setSelected] = React.useState(endpoint.session_id || '')
    React.useEffect(() => setSelected(endpoint.session_id || ''), [endpoint.session_id])
    const options = sessions.some((s) => s.id === endpoint.session_id) ? sessions : [{ id: endpoint.session_id, title: '当前固定会话' }, ...sessions].filter((s) => s.id)
    return h('div', { className: 'ah-session-row' },
      h('div', { className: 'ah-split' }, h('strong', null, 'Harness Session'), badge(endpoint.ready ? '就绪' : '未就绪', endpoint.ready)),
      h('p', { className: 'ah-subtle' }, '当前：', h('code', null, endpoint.session_id || '等待创建')),
      endpoint.unavailable_reason && h('p', { className: 'ah-subtle' }, friendly(endpoint.unavailable_reason)),
      field('固定会话', h('select', { value: selected, onChange: (e) => setSelected(e.target.value), 'aria-label': 'Harness 固定会话' }, h('option', { value: '' }, '新建专用 Session'), options.map((s) => h('option', { key: s.id, value: s.id }, `${s.title || s.id} · ${s.id}`)))),
      h('button', { disabled: busy, onClick: () => run('worker.session.bind', { runtime: endpoint.runtime, session_id: selected || null }, '固定会话已保存') }, '保存会话绑定'))
  }

  function Panel({ call }) {
    const [data, setData] = React.useState(null), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false)
    const [sessions, setSessions] = React.useState([]), [targets, setTargets] = React.useState([]), [targetKey, setTargetKey] = React.useState(''), [masterSession, setMasterSession] = React.useState(''), [masterId, setMasterId] = React.useState('')
    const [pair, setPair] = React.useState(null), [clock, setClock] = React.useState(Date.now())
    const [unpairTarget, setUnpairTarget] = React.useState(null)
    const [hub, setHub] = React.useState(''), [name, setName] = React.useState(''), [cwd, setCwd] = React.useState(''), [code, setCode] = React.useState(''), [ca, setCa] = React.useState(''), [replace, setReplace] = React.useState(false)
    const [address, setAddress] = React.useState(''), [listenHost, setListenHost] = React.useState(''), [port, setPort] = React.useState(''), [certFile, setCertFile] = React.useState(''), [keyFile, setKeyFile] = React.useState(''), [workerDirectory, setWorkerDirectory] = React.useState('')
    const initialized = React.useRef(false)
    const refresh = React.useCallback(async () => { const value = await call('status'); setData(value); return value }, [call])
    React.useEffect(() => {
      let alive = true, loading = false
      const poll = async () => { if (loading) return; loading = true; try { const value = await call('status'); if (alive) setData(value) } catch (e) { if (alive) setError(friendly(e)) } finally { loading = false } }
      poll(); const timer = setInterval(poll, 5000)
      return () => { alive = false; clearInterval(timer) }
    }, [call])
    React.useEffect(() => { if (!pair) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [pair])
    React.useEffect(() => { if (data?.settings.workerHome) setWorkerDirectory(data.settings.workerHome) }, [data?.settings.workerHome])
    React.useEffect(() => {
      if (!data || initialized.current) return
      initialized.current = true
      setHub(data.worker?.config?.hub || data.defaults.hub || ''); setName(data.worker?.config?.name || data.defaults.name || ''); setCwd(data.worker?.config?.cwd || '')
      setAddress(data.settings.publicUrl || ''); setListenHost(data.settings.host); setPort(String(data.settings.port)); setMasterId(data.master?.masters[0]?.id || ''); setWorkerDirectory(data.settings.workerHome || '')
    }, [data])
    React.useEffect(() => {
      if (!data) return
      let alive = true
      call('sessions.list').then((v) => { if (alive) setSessions(v.sessions) }).catch((e) => { if (alive) setError('无法读取本机会话：' + friendly(e)) })
      if (data.settings.role === 'hub') call('targets.list').then((v) => { if (alive) setTargets(v.targets) }).catch(() => {})
      return () => { alive = false }
    }, [call, data?.settings.role, data?.phase])
    const run = async (method, payload = {}, message = '已保存') => {
      setBusy(true); setError(''); setNotice('')
      try { const result = await call(method, payload); if (method === 'pair.create') { setPair({ ...result, expires_at: Date.now() + result.expires_in * 1000 }); setClock(Date.now()) }; setNotice(method === 'worker.check' ? `通信正常，往返 ${result.latency_ms} ms` : message); await refresh(); return result }
      catch (e) { setError(friendly(e)); return null }
      finally { setBusy(false) }
    }
    if (!data) return h('div', { className: 'ah-page' }, h('h1', null, 'Agent Hub'), error ? h('p', { role: 'alert' }, error) : h('p', null, '正在读取插件状态…'))
    const role = data.settings.role, masters = data.master?.masters || [], devices = data.master?.devices || [], communication = data.worker?.communication
    const selectedTarget = targets.find((t) => `${t.bot_id}/${t.target_id}` === targetKey)
    const remaining = pair ? Math.max(0, Math.ceil((pair.expires_at - clock) / 1000)) : 0
    const used = pair && data.master?.pairs?.some((p) => p.pair_id === pair.pair_id && p.status === 'used')
    return h('div', { className: 'ah-page', 'data-agent-hub-page': role },
      h('div', { className: 'ah-top' }, h('div', null, h('div', { className: 'ah-kicker' }, 'AGENT HUB / DEVICE CONTROL'), h('h1', null, '设备与会话'), h('p', null, '微信主控 · 多设备执行 · 固定会话')), h('div', { className: 'ah-row' }, badge(labels[data.phase] || data.phase, data.phase === 'running'), h('span', { className: 'ah-subtle' }, '最新版本'), h('button', { disabled: busy, onClick: () => run('status', {}, '状态已刷新') }, '刷新'))),
      error && h('div', { className: 'ah-notice ah-error', role: 'alert' }, error), notice && h('div', { className: 'ah-notice', role: 'status' }, notice), data.error && h('div', { className: 'ah-notice ah-error' }, friendly(data.error)),
      h('div', { className: 'ah-stats' },
        h('div', { className: 'ah-stat' }, h('small', null, '设备角色'), h('strong', null, role === 'hub' ? '主机' : role === 'harness' ? '从机' : '尚未配置')),
        h('div', { className: 'ah-stat' }, h('small', null, role === 'hub' ? '在线设备' : '主机连接'), h('strong', null, role === 'hub' ? `${devices.filter((d) => d.online).length} / ${devices.length}` : communication?.connected ? '已连接' : '未连接')),
        h('div', { className: 'ah-stat' }, h('small', null, '自动启动'), h('strong', null, '随 Harness 启动'))),
      role === 'setup' && h('div', { className: 'ah-card' }, h('h2', null, '选择这台设备的用途'), h('div', { className: 'ah-choices' }, h('button', { disabled: busy, onClick: () => run('settings.save', { role: 'hub' }, '已设为主机') }, '用作主机', h('p', null, '连接微信，派发任务')), h('button', { disabled: busy, onClick: () => run('settings.save', { role: 'harness' }, '已设为从机') }, '用作从机', h('p', null, '连接主机，执行任务')))),
      role === 'hub' && h(React.Fragment, null,
        h('div', { className: 'ah-card', 'data-testid': 'pending-reports' },
          h('div', { className: 'ah-split' }, h('h2', null, '待处理任务结果'), badge(`${data.master?.reports?.pending_count || 0} 项`, !data.master?.reports?.pending_count)),
          h('p', { className: 'ah-note' }, '执行结束通知由插件独立投递微信。结果持续保留，直到主 Agent 明确确认消费；微信已送达不等于主 Agent 已处理。'),
          (data.master?.reports?.delivery_issues || []).filter(n => !(data.master?.reports?.items || []).some(r => r.task_id === n.task_id)).map(n => h('div', { className: 'ah-notice ah-error', key: n.id }, h('code', null, n.task_id), h('p', null, `主 Agent 已处理，微信投递仍需关注：${({ unknown: '发送结果待核查，不自动重发', failed: '投递失败', blocked: '目标变更，已暂停', sending: '投递中', pending: '待投递' })[n.state] || n.state}`))),
          (data.master?.reports?.items || []).map((r) => h('div', { className: 'ah-device ah-report', key: r.report_id },
            h('code', null, r.task_id), h('p', null, `执行：${r.status} · 微信：${({ sent: '已通知', pending: '待投递', failed: '投递失败', sending: '投递中', unknown: '发送结果待核查', blocked: '目标变更，已暂停' })[r.delivery] || r.delivery} · 主 Agent 待确认`),
            h('p', { className: 'ah-subtle' }, date(r.finished_at || r.created_at)), r.answer_excerpt && h('details', null, h('summary', null, '查看最终答复摘录'), h('p', { style: { whiteSpace: 'pre-wrap' } }, r.answer_excerpt))))),
        data.phase === 'waiting_im' && h('div', { className: 'ah-card' }, h('h2', null, '等待微信接入'), h('p', null, '请安装并启用 DSH-IM，为微信私聊目标开启会话同步。服务就绪后会自动启动主机。')),
        h('div', { className: 'ah-grid' },
          h('div', { className: 'ah-card' }, h('h2', null, '微信主会话'),
            field('微信目标', h('select', { value: targetKey, onChange: (e) => { const t = targets.find((t) => `${t.bot_id}/${t.target_id}` === e.target.value); setTargetKey(e.target.value); setMasterSession(t?.session_id || '') } }, h('option', { value: '' }, '选择已开启同步的微信目标'), targets.map((t) => h('option', { key: `${t.bot_id}/${t.target_id}`, value: `${t.bot_id}/${t.target_id}`, disabled: !t.sync_enabled }, t.name + (t.sync_enabled ? '' : '（未开启同步）'))))),
            field('主 Session', h('select', { value: masterSession, onChange: (e) => setMasterSession(e.target.value) }, h('option', { value: '' }, '选择目标对应的 Session'), sessions.map((s) => h('option', { key: s.id, value: s.id }, `${s.title || s.id} · ${s.id}`)))),
            h('button', { className: 'ah-primary', disabled: busy || !selectedTarget || !masterSession, onClick: async () => { const result = await run('master.bind', { session_id: masterSession, bot_id: selectedTarget.bot_id, target_id: selectedTarget.target_id }, '微信主会话已绑定'); if (result) setMasterId(masterSession) } }, '保存主会话'),
            masters.map((m) => h('p', { className: 'ah-note', key: m.id }, '已绑定：', h('code', null, m.session_id)))),
          h('div', { className: 'ah-card' }, h('h2', null, '配对新设备'),
            field('归属主会话', h('select', { value: masterId, onChange: (e) => setMasterId(e.target.value) }, h('option', { value: '' }, '先绑定微信主会话'), masters.map((m) => h('option', { key: m.id, value: m.id }, sessions.find((s) => s.id === m.id)?.title || m.id)))),
            h('button', { className: 'ah-primary', disabled: busy || !masterId, onClick: () => run('pair.create', { master_id: masterId }, '配对码已生成') }, '生成配对码'),
            pair && h('div', null, h('output', { className: 'ah-code', 'data-testid': 'pair-code' }, used ? '已使用' : remaining ? pair.code : '已过期'), h('div', { className: 'ah-row' }, h('span', { className: 'ah-subtle' }, used ? '设备已完成配对' : remaining ? `${remaining} 秒后过期 · 仅可使用一次` : '请重新生成配对码'), h('button', { disabled: !remaining || used, onClick: () => navigator.clipboard?.writeText(pair.code) }, '复制'))),
            h('p', { className: 'ah-note' }, '主机地址：', h('code', null, data.settings.publicUrl || '尚未填写公网地址')))),
        h('div', { className: 'ah-card' }, h('div', { className: 'ah-split' }, h('h2', null, '绑定设备'), h('span', { className: 'ah-subtle' }, `${devices.length} 台设备`)),
          !devices.length && h('div', { className: 'ah-empty' }, '还没有绑定设备。生成配对码后，在从机页面完成绑定。'),
          devices.map((d) => h('div', { className: 'ah-device', key: d.id }, h('div', { className: 'ah-split' }, h('strong', null, d.name), badge(d.online ? '在线' : '离线', d.online)), h('code', null, d.id), h('div', { className: 'ah-subtle' }, '最近通信：', date(d.last_seen_at)),
            h('button', { disabled: busy, onClick: () => setUnpairTarget(d.id) }, '解绑设备'),
            unpairTarget === d.id && h('div', { className: 'ah-notice' }, h('p', null, '解绑将撤销该设备的连接权限，保留会话和任务记录。未结束的任务会阻止解绑。'), h('div', { className: 'ah-row' }, h('button', { disabled: busy, onClick: () => run('device.unpair', { device_id: d.id }, '设备已解绑，旧凭据已撤销').then((result) => { if (result) setUnpairTarget(null) }) }, '确认解绑设备'), h('button', { disabled: busy, onClick: () => setUnpairTarget(null) }, '取消'))),
            !d.endpoints.length && h('p', null, '设备已配对，等待执行入口启动。'),
            d.endpoints.map((e) => h('div', { key: e.id, className: 'ah-endpoint' }, h('div', { className: 'ah-split' }, h('span', null, 'Harness'), badge(e.ready ? '入口就绪' : '未就绪', e.ready)), h('code', null, e.session_id || '固定会话尚未创建'), e.unavailable_reason && h('p', { className: 'ah-subtle' }, friendly(e.unavailable_reason)))))))),
      role === 'harness' && h('div', { className: 'ah-grid' },
        h('div', { className: 'ah-card' }, h('h2', null, data.worker?.paired ? '设备配对信息' : '绑定主机'),
          data.worker?.paired && h('div', null, badge('已配对', true), h('p', null, h('code', null, data.worker.config.device_id)), h('p', null, data.worker.config.hub), h('p', { className: 'ah-subtle' }, '工作目录：', data.worker.config.cwd), h('label', { className: 'ah-check' }, h('input', { type: 'checkbox', checked: replace, onChange: (e) => setReplace(e.target.checked) }), '重新配对到主机')),
          data.worker?.paired && h('button', { disabled: busy || !!communication?.active_tasks?.length, onClick: () => setUnpairTarget('worker') }, '解绑主机'),
          data.worker?.paired && unpairTarget === 'worker' && h('div', { className: 'ah-notice' }, h('p', null, '收到主机的撤销回执后清理本地绑定并停止此设备的自启动；保留 Session 和任务记录。主机不可用时保留绑定，请恢复通信后重试。'), h('div', { className: 'ah-row' }, h('button', { disabled: busy, onClick: () => run('worker.unpair', {}, '已解绑主机，固定会话和任务记录已保留').then((result) => { if (result) { setUnpairTarget(null); setReplace(false) } }) }, '确认解绑主机'), h('button', { disabled: busy, onClick: () => setUnpairTarget(null) }, '取消'))),
          (!data.worker?.paired || replace) && h('form', { onSubmit: (e) => { e.preventDefault(); run('worker.pair', { hub, code, name, cwd, ca_pem: ca || undefined, replace }, '设备已绑定，正在启动固定会话').then((result) => { if (result) { setCode(''); setReplace(false) } }) } },
            field('主机地址', input(hub, setHub, { required: true, placeholder: 'https://公网IP:9443' })), field('配对码', input(code, setCode, { required: true, autoComplete: 'off', placeholder: '主机生成的一次性配对码' })),
            field('设备名称', input(name, setName, { required: true })), field('本机工作目录', input(cwd, setCwd, { required: true, placeholder: 'C:\\work' })),
            h('details', null, h('summary', null, '主机证书选项'), field('主机公开证书（PEM）', h('textarea', { value: ca, onChange: (e) => setCa(e.target.value), rows: 4, placeholder: '当前主机的证书已内置；更换自签名主机时填写其公开证书。' }))),
            h('button', { className: 'ah-primary', disabled: busy, type: 'submit' }, '绑定并自动连接')),
          h('p', { className: 'ah-note' }, '模型、凭据、工具与权限沿用从机本地配置。需要 Codex 时，由此 Harness 的本地 sub agent 调用，任务结果仍由 Harness 汇总。')),
        h('div', { className: 'ah-card' }, h('div', { className: 'ah-split' }, h('h2', null, '通信与固定会话'), badge(communication?.connected ? '已连接主机' : '未连接', communication?.connected)),
          h('p', { className: 'ah-subtle' }, 'Worker：', labels[data.worker?.state] || data.worker?.state || '等待启动'), h('p', { className: 'ah-subtle' }, '最近通信：', date(communication?.last_contact_at)),
          communication?.connection_error && h('p', null, friendly(communication.connection_error)), data.worker?.state?.startsWith('error:') && h('p', null, friendly(data.worker.state.slice(6))),
          h('button', { disabled: busy || !data.worker?.paired, onClick: () => run('worker.check') }, '检查通信'),
          (communication?.endpoints || []).map((e) => h(SessionBinding, { key: e.runtime, endpoint: e, sessions, run, busy: busy || !!communication.active_tasks?.length })),
          h('p', { className: 'ah-note' }, '未指定会话时自动创建专用会话。已有会话会在软件重启后恢复。'))),
      role !== 'setup' && h('details', { className: 'ah-card' }, h('summary', null, '插件角色与连接设置'),
        h('div', { style: { marginTop: 18 } }, role === 'hub' && h(React.Fragment, null,
          field('从机使用的公网地址', input(address, setAddress, { placeholder: 'https://公网IP:9443' })), h('div', { className: 'ah-grid' }, field('监听地址', input(listenHost, setListenHost)), field('监听端口', input(port, setPort, { type: 'number' }))),
          h('details', null, h('summary', null, '更换本机 TLS 证书文件'), field('公开证书路径', input(certFile, setCertFile)), field('私钥文件路径', input(keyFile, setKeyFile))),
          h('button', { disabled: busy, onClick: () => run('settings.save', { role, publicUrl: address, host: listenHost, port: Number(port), ...(certFile || keyFile ? { certFile, keyFile } : {}) }, '连接设置已保存') }, '保存连接设置')),
          role === 'harness' && h(React.Fragment, null, field('Harness 从机数据目录', input(workerDirectory, setWorkerDirectory)), h('button', { disabled: busy, onClick: () => run('settings.save', { role, workerHome: workerDirectory }, 'Harness 数据目录已保存') }, '保存从机目录'), h('p', { className: 'ah-note' }, '从机随 Harness 启动。一个设备绑定一个固定 Harness Session。')),
          h('p', { className: 'ah-note' }, '切换角色会停止当前角色的服务，已有账本和绑定保留。'), h('button', { disabled: busy, onClick: () => run('settings.save', { role: role === 'hub' ? 'harness' : 'hub' }, '设备角色已切换') }, role === 'hub' ? '切换为从机' : '切换为主机'))))
  }

  return { name: 'agent-hub-settings', inject: ['slots', 'connection'], apply(ctx) {
    const call = async (method, payload = {}) => {
      const result = await ctx.connection.rpc.call('/api', 'agent-hub', { method, payload })
      if (!result.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code })
      return result.value
    }
    const render = () => h(Panel, { call })
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove() })
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-hub', order: 22, label: () => 'Agent Hub 设备' }, render)))
    ctx.inject(['layout', 'pluginNavigation'], (scope) => scope.slots.inject('main', () => {
      const page = scope.slots.register({ name: 'main', key: 'agent-hub' }, render)
      const action = scope.slots.inject('plugins.detail.actions', () => scope.slots.register({ name: 'plugins.detail.actions', id: 'agent-hub-open', order: 22 }, ({ subject }) => {
        if (!['bundle', 'row'].includes(subject?.kind) || subject.pkg?.name !== 'dsh-agent-hub') return null
        return h('button', { type: 'button', onClick: () => scope.layout.selectPanel('agent-hub') }, '打开设备控制台')
      }))
      return () => { action(); page() }
    }))
  } }
} })

import type { AppLocale, MessageCatalog } from './types';

/**
 * Key naming: domain.section.item
 * - welcome.*   home screen
 * - slash.*     slash command help
 * - status.*    header status / modes
 * - session.*   persistence / resume
 * - approval.*  tool approval panel
 * - tool.*      tool card chrome
 * - thinking.*  thinking labels / phases
 * - settings.*  model settings panel
 * - cmd.*       slash command replies
 * - composer.*  input box
 * - common.*    shared fragments
 */
export const zhCatalog = {
  // welcome
  'welcome.headline': '随时可以开始',
  'welcome.subtitle': '在当前工作区规划、调用工具并保留运行记录。',
  'welcome.tip': '输入 / 查看全部命令',
  'welcome.tipPrefix': '提示：',
  'welcome.modelPrefix': '模型 ',
  'welcome.action.start': '输入内容开始新会话',
  'welcome.action.startShortcut': '输入后 ↵',
  'welcome.action.commands': '查看命令',
  'welcome.action.settings': '模型与思考强度',
  'welcome.recentTitle': '最近会话',
  'welcome.selectHint': '↑↓ 选择',
  'welcome.selectedHint': '已选中 · Esc 取消',
  'welcome.hintIdle': '使用 ↑↓ 选择会话 · 输入内容开始新会话',
  'welcome.hintResume': 'Enter 恢复已选中会话',
  'welcome.hintCancel': ' · Esc 取消选择',

  // composer
  'composer.noModel': '未配置模型',
  'composer.placeholder': '描述任务，输入 / 查看命令',

  // header
  'header.queue': '队列：{count}',
  'header.todo.empty': 'Todo · —',
  'header.todo.progress': 'Todo {done}/{total}',
  'header.todo.more': '+{count}',

  // status / mode / permission
  'status.ready': '就绪',
  'status.responding': '思考中',
  'status.interrupting': '正在中断',
  'status.waitingPlan': '等待计划确认',
  'status.waitingTool': '等待工具确认',
  'mode.auto': '自动',
  'mode.normal': '普通',
  'mode.conductor': '指挥家',
  'perm.default': '权限：默认',
  'perm.classifier': '权限：智能判断',
  'perm.auto': '权限：自动允许',
  'perm.unknown': '权限：{mode}',

  // slash commands
  'slash.help.desc': '查看全部命令',
  'slash.settings.desc': '模型与思考强度',
  'slash.model.desc': '切换模型或思考强度',
  'slash.mode.desc': '切换 Agent 模式',
  'slash.resume.desc': '打开会话选择或恢复指定会话',
  'slash.lang.desc': '切换界面语言',
  'slash.status.desc': '查看当前运行状态',
  'slash.context.desc': '查看会话上下文占用',
  'slash.compact.desc': '手动触发轮次压缩',
  'slash.trace.desc': '查看最近运行记录',
  'slash.diff.desc': '查看文件与 Git 变更',
  'slash.perm.desc': '切换工具权限模式',
  'slash.import.desc': '导入 Claude Code / Codex 配置',
  'slash.approve.desc': '确认等待中的指挥家计划',
  'slash.reject.desc': '取消等待中的指挥家计划',
  'slash.addDir.desc': '将会话工作区增加一个目录',
  'slash.dirs.desc': '列出当前会话工作区目录',
  'slash.removeDir.desc': '移除通过 /add-dir 加入的目录',
  'slash.expand.desc': '切换最近一条思考过程折叠（等同 ctrl+o）',
  'slash.help.header': '可用命令：',
  'slash.category.common': '常用',
  'slash.category.inspection': '运行检查',
  'slash.category.settings': '设置',
  'slash.category.contextual': '当前操作',
  'slash.suggest.title': '命令',

  // approval
  'approval.read.title': '允许读取工作区？',
  'approval.read.risk': '只读访问',
  'approval.write.title': '允许修改工作区？',
  'approval.write.risk': '文件写入',
  'approval.execute.title': '允许执行命令？',
  'approval.execute.risk': '命令执行',
  'approval.execute.input': '命令',
  'approval.network.title': '允许访问网络？',
  'approval.network.risk': '网络访问',
  'approval.network.input': '请求',
  'approval.default.title': '允许这次工具调用？',
  'approval.input': '输入',
  'approval.reason': '该操作需要你的确认',
  'approval.hotkeys': ' ←/→ 切换 · Enter 确认 · a/r 快捷键',

  // tool cards
  'tool.status.failed': '失败',
  'tool.status.rejected': '已拒绝',
  'tool.status.waiting': '等待确认',
  'tool.status.cancelled': '已中断',

  // thinking
  'thinking.active': '思考中…',
  'thinking.activeSpinner': '思考中… {spinner}',
  'thinking.activeElapsed': '思考中… {seconds} 秒',
  'thinking.activeElapsedSpinner': '思考中… {seconds} 秒 {spinner}',
  'thinking.elapsed': '{seconds} 秒',
  'thinking.duration': '思考了 {seconds} 秒',
  'thinking.process': '思考过程',
  'thinking.label': '思考中',
  'thinking.toolLabel': '正在执行',
  'thinking.phase.read': '读取工作区',
  'thinking.phase.plan': '规划下一步',
  'thinking.phase.waitModel': '等待模型',
  'thinking.phase.compose': '整理回复',
  'thinking.phase.runTool': '运行已允许的工具',
  'thinking.phase.collect': '收集工具输出',
  'thinking.phase.handOff': '将结果交给模型',
  'thinking.phase.cancelling': '正在中断',
  'thinking.interruptHint': 'Esc 中断',

  // scroll
  'scroll.both': '↑ 历史  ·  ↓ 底部',
  'scroll.up': '↑ 历史',
  'scroll.down': '↓ 回底部',

  // model settings
  'settings.title': '模型与思考强度',
  'settings.effort': '思考强度',
  'settings.model': '模型',
  'settings.noModels': '暂无可用模型，请先配置环境变量',
  'settings.unconfigured': '{example} · {provider} (未配置)',
  'settings.noEffort': '未选择思考强度',
  'settings.effortOnly': '思考强度 → {effort}',
  'settings.missingKey': '{name} 未配置密钥（{envs}）',
  'settings.applied': '已应用 {label}',
  'settings.hotkeys': '←/→ 分区 · ↑/↓ 选择 · Enter 应用 · Esc 关闭 · ctrl+p 开关',

  // session
  'session.readFailed': '读取历史会话失败',
  'session.createFailed': '创建会话失败，已切换为临时会话',
  'session.saveFailed': '保存会话失败',
  'session.syncFailed': '同步会话失败',
  'session.disabled': '当前运行环境未启用会话持久化。',
  'session.busy': '当前任务尚未结束，完成或处理工具确认后再恢复其他会话。',
  'session.empty': '当前工作区还没有可恢复的历史会话。',
  'session.notFound': '未找到唯一匹配的会话：{target}',
  'session.resumeFailed': '恢复会话失败',
  'session.storeInitNodeMismatch':
    '会话存储初始化失败：better-sqlite3 与当前 Node.js {version}{abi} 不兼容。',
  'session.storeInitNodeHint':
    'Kross 要求 Node.js >=22.19；请执行 `nvm use` 后运行 `npm rebuild better-sqlite3`。',
  'session.storeInitNoPersist': '当前内容不会保存。',
  'session.storeInitGeneric': '会话存储初始化失败，当前内容不会保存：{detail}',
  'session.errorDetail': '{prefix}：{detail}',

  // app runtime notices
  'app.runError': '运行出错：{error}',
  'app.conductorPaused':
    '指挥家模式已暂停，等待确认计划。输入 /approve 继续，或 /reject 取消。',
  'app.toolApproved': '已允许一次 {tool}，继续执行。',
  'app.toolRejected': '已拒绝 {tool}，继续让模型调整方案。',
  'app.approvalError': '处理审批时出错：{error}',
  'app.noConductorPlan': '当前没有等待确认的指挥家计划。',
  'app.conductorCancelled': '已取消指挥家计划。',
  'app.conductorConfirmed': '已确认指挥家计划，继续执行。',
  'app.runtimeFallback': '模型配置加载失败：{error} · 已回退本地运行时',
  'app.queued': '已加入队列：{count}',
  'app.interrupted': '已中断当前任务。',
  'app.queuePaused': '队列中还有 {count} 条消息，已暂停；按 Enter 继续。',

  // commands
  'cmd.status':
    '当前运行在本地 TUI。mode={mode} · perm={perm} · model={model}',
  'cmd.expandDone': '已切换最近一条 thinking 的折叠状态（也可用 ctrl+o）。',
  'cmd.modeUsage': '用法：/mode auto|normal|conductor',
  'cmd.modeSwitched': '已切换到 {mode} 模式',
  'cmd.modeUnknown': '未知模式，可选：auto、normal、conductor（兼容 cross-repo）',
  'cmd.addDir.usage': '用法：/add-dir <绝对或相对路径>',
  'cmd.addDir.ok': '已加入工作区 id={id} path={path}',
  'cmd.addDir.fail': '加入失败：{error}',
  'cmd.addDir.unavailable': '当前运行时未启用多目录工作区。',
  'cmd.dirs.empty': '当前仅有主工作区（未 /add-dir）。',
  'cmd.dirs.header': '会话工作区目录：',
  'cmd.removeDir.usage': '用法：/remove-dir <id|path>',
  'cmd.removeDir.ok': '已移除：{target}',
  'cmd.removeDir.missing': '未找到：{target}',
  'cmd.removeDir.fail': '移除失败：{error}',
  'cmd.permUsage': '用法：/perm default|classifier|auto · 也可按 shift+tab 循环切换',
  'cmd.permUnknown': '未知权限模式，可选：default、classifier、auto',
  'cmd.unknown': '未知命令：{value}。输入 /help 查看可用命令。',
  'cmd.import.detectOne': '检测到 {name} 配置。',
  'cmd.import.importOne':
    '输入 /import {source} 一键导入，或输入 /import skip 跳过。',
  'cmd.import.detectMany': '检测到 {names} 配置。',
  'cmd.import.choose':
    '请选择一个导入：/import claude 或 /import codex；也可以输入 /import skip 跳过。',
  'cmd.asyncFailed': '{command} 失败：{message}',
  'cmd.import.none': '当前没有可导入的 Claude Code 或 Codex 配置。',
  'cmd.import.skipped': '已跳过配置导入。记录已保存到 {path}',
  'cmd.import.done': '已导入 {name} 配置。',
  'cmd.import.configPath': '配置文件: {path}',
  'cmd.import.defaultBase': '默认',
  'cmd.import.credentialYes': '已配置',
  'cmd.import.credentialNo': '未配置',
  'cmd.import.failed': '导入失败：{error}',
  'cmd.import.usage': '用法：{commands} | /import skip',
  'cmd.context.totalChars': '总字符: {chars}',
  'cmd.context.title': 'Context',
  'cmd.context.estimated': '预估 token',
  'cmd.context.budget': '输入预算',
  'cmd.context.threshold': '压缩阈值',
  'cmd.context.lastUsage': '上次请求 input',
  'cmd.context.sections': 'sections (tokens):',
  'cmd.context.sources': 'sources:',
  'cmd.context.maintenance': '最近治理:',
  'cmd.context.noMaintenance': '(none)',
  'cmd.compact.done':
    '已压缩 {turns} 轮 · {before} -> {after} tokens（Stage2）',
  'cmd.compact.nothing': '无可压缩内容（需保留最近 {preserve} 轮全文）',
  'cmd.compact.running': '正在压缩上下文，请稍候…',
  'cmd.compact.busy': '当前仍有任务或压缩正在进行，不能并发修改上下文。',
  'cmd.lang.usage': '用法：/lang zh|en',
  'cmd.lang.current': '当前界面语言：{locale}',
  'cmd.lang.switched': '界面语言已切换为 {locale}',
  'cmd.lang.unknown': '未知语言，可选：zh、en',
  'cmd.lang.and': ' 和 ',

  // context maintenance
  'context.restoredTruncated':
    '已恢复会话：模型上下文保留最近 {kept} 条（含摘要），另有 {dropped} 条较早对话已压缩为摘要。',
  'context.restoredHardTrim':
    '已恢复会话：模型上下文仅保留最近 {kept} 条对话，另有 {dropped} 条较早记录未载入模型。',
  'context.compactedNotice':
    '上下文已压缩: {stage}, {before} -> {after} tokens',
  'context.restoredInterrupted':
    '上次会话在未完成轮次中断；悬空工具调用已取消，请重新确认后续操作。'
} as const satisfies MessageCatalog;

export type MessageKey = keyof typeof zhCatalog;

export const enCatalog: Record<MessageKey, string> = {
  'welcome.headline': 'Ready when you are',
  'welcome.subtitle':
    'Plan, run tools, and keep a record of work in this workspace.',
  'welcome.tip': 'Type / to see all commands',
  'welcome.tipPrefix': 'Tip: ',
  'welcome.modelPrefix': 'Model ',
  'welcome.action.start': 'Type to start a new session',
  'welcome.action.startShortcut': 'type then ↵',
  'welcome.action.commands': 'Browse commands',
  'welcome.action.settings': 'Model & thinking effort',
  'welcome.recentTitle': 'Recent sessions',
  'welcome.selectHint': '↑↓ select',
  'welcome.selectedHint': 'Selected · Esc cancel',
  'welcome.hintIdle': 'Use ↑↓ to pick a session · type to start new',
  'welcome.hintResume': 'Enter to resume selected session',
  'welcome.hintCancel': ' · Esc to deselect',

  'composer.noModel': 'No model',
  'composer.placeholder': 'Describe a task, type / for commands',

  'header.queue': 'Queue: {count}',
  'header.todo.empty': 'Todo · —',
  'header.todo.progress': 'Todo {done}/{total}',
  'header.todo.more': '+{count}',

  'status.ready': 'Ready',
  'status.responding': 'Thinking',
  'status.interrupting': 'Interrupting',
  'status.waitingPlan': 'Awaiting plan approval',
  'status.waitingTool': 'Awaiting tool approval',
  'mode.auto': 'Auto',
  'mode.normal': 'Normal',
  'mode.conductor': 'Conductor',
  'perm.default': 'Perm: default',
  'perm.classifier': 'Perm: classifier',
  'perm.auto': 'Perm: auto-allow',
  'perm.unknown': 'Perm: {mode}',

  'slash.help.desc': 'Show all commands',
  'slash.settings.desc': 'Model & thinking effort',
  'slash.model.desc': 'Switch model or thinking effort',
  'slash.mode.desc': 'Switch agent mode',
  'slash.resume.desc': 'Open session picker or resume by id',
  'slash.lang.desc': 'Switch UI language',
  'slash.status.desc': 'Show current status',
  'slash.context.desc': 'Show context usage',
  'slash.compact.desc': 'Manually compact conversation turns',
  'slash.trace.desc': 'Show recent run traces',
  'slash.diff.desc': 'Show file and git changes',
  'slash.perm.desc': 'Switch tool permission mode',
  'slash.import.desc': 'Import Claude Code / Codex config',
  'slash.approve.desc': 'Approve pending conductor plan',
  'slash.reject.desc': 'Reject pending conductor plan',
  'slash.addDir.desc': 'Add a directory to this session workspace',
  'slash.dirs.desc': 'List session workspace directories',
  'slash.removeDir.desc': 'Remove a directory added via /add-dir',
  'slash.expand.desc': 'Toggle last thinking block (same as ctrl+o)',
  'slash.help.header': 'Available commands:',
  'slash.category.common': 'Common',
  'slash.category.inspection': 'Inspect',
  'slash.category.settings': 'Settings',
  'slash.category.contextual': 'Contextual',
  'slash.suggest.title': 'Commands',

  'approval.read.title': 'Allow reading the workspace?',
  'approval.read.risk': 'Read-only',
  'approval.write.title': 'Allow modifying the workspace?',
  'approval.write.risk': 'File write',
  'approval.execute.title': 'Allow running a command?',
  'approval.execute.risk': 'Command execution',
  'approval.execute.input': 'Command',
  'approval.network.title': 'Allow network access?',
  'approval.network.risk': 'Network',
  'approval.network.input': 'Request',
  'approval.default.title': 'Allow this tool call?',
  'approval.input': 'Input',
  'approval.reason': 'This action needs your confirmation',
  'approval.hotkeys': ' ←/→ switch · Enter confirm · a/r shortcuts',

  'tool.status.failed': 'failed',
  'tool.status.rejected': 'rejected',
  'tool.status.waiting': 'awaiting approval',
  'tool.status.cancelled': 'interrupted',

  'thinking.active': 'Thinking…',
  'thinking.activeSpinner': 'Thinking… {spinner}',
  'thinking.activeElapsed': 'Thinking… {seconds}s',
  'thinking.activeElapsedSpinner': 'Thinking… {seconds}s {spinner}',
  'thinking.elapsed': '{seconds}s',
  'thinking.duration': 'Thought for {seconds}s',
  'thinking.process': 'Thinking',
  'thinking.label': 'Thinking',
  'thinking.toolLabel': 'Running',
  'thinking.phase.read': 'Reading workspace',
  'thinking.phase.plan': 'Planning next step',
  'thinking.phase.waitModel': 'Waiting for model',
  'thinking.phase.compose': 'Composing reply',
  'thinking.phase.runTool': 'Running approved tools',
  'thinking.phase.collect': 'Collecting tool output',
  'thinking.phase.handOff': 'Sending results to model',
  'thinking.phase.cancelling': 'Interrupting',
  'thinking.interruptHint': 'Esc to interrupt',

  'scroll.both': '↑ history  ·  ↓ bottom',
  'scroll.up': '↑ history',
  'scroll.down': '↓ bottom',

  'settings.title': 'Model & thinking effort',
  'settings.effort': 'Effort',
  'settings.model': 'Model',
  'settings.noModels': 'No models available — configure env vars first',
  'settings.unconfigured': '{example} · {provider} (not configured)',
  'settings.noEffort': 'No thinking effort selected',
  'settings.effortOnly': 'Effort → {effort}',
  'settings.missingKey': '{name} has no credentials ({envs})',
  'settings.applied': 'Applied {label}',
  'settings.hotkeys':
    '←/→ sections · ↑/↓ select · Enter apply · Esc close · ctrl+p toggle',

  'session.readFailed': 'Failed to load sessions',
  'session.createFailed': 'Failed to create session; using a temporary one',
  'session.saveFailed': 'Failed to save session',
  'session.syncFailed': 'Failed to sync session',
  'session.disabled': 'Session persistence is not enabled in this environment.',
  'session.busy':
    'A task is still running. Finish it or handle tool approval before resuming another session.',
  'session.empty': 'No resumable sessions in this workspace yet.',
  'session.notFound': 'No unique session match for: {target}',
  'session.resumeFailed': 'Failed to resume session',
  'session.storeInitNodeMismatch':
    'Session store init failed: better-sqlite3 is incompatible with Node.js {version}{abi}.',
  'session.storeInitNodeHint':
    'Kross requires Node.js >=22.19; run `nvm use` then `npm rebuild better-sqlite3`.',
  'session.storeInitNoPersist': 'Current content will not be saved.',
  'session.storeInitGeneric':
    'Session store init failed; current content will not be saved: {detail}',
  'session.errorDetail': '{prefix}: {detail}',

  'app.runError': 'Run error: {error}',
  'app.conductorPaused':
    'Conductor mode paused for plan approval. Type /approve to continue or /reject to cancel.',
  'app.toolApproved': 'Allowed one {tool} call; continuing.',
  'app.toolRejected': 'Rejected {tool}; model will adjust the plan.',
  'app.approvalError': 'Approval handling error: {error}',
  'app.noConductorPlan': 'No conductor plan is waiting for approval.',
  'app.conductorCancelled': 'Conductor plan cancelled.',
  'app.conductorConfirmed': 'Conductor plan confirmed; continuing.',
  'app.runtimeFallback':
    'Failed to load model config: {error} · fell back to local runtime',
  'app.queued': 'Queued: {count}',
  'app.interrupted': 'Interrupted the current task.',
  'app.queuePaused': '{count} queued message(s) paused; press Enter to continue.',

  'cmd.status':
    'Running local TUI. mode={mode} · perm={perm} · model={model}',
  'cmd.expandDone':
    'Toggled the latest thinking block (also available via ctrl+o).',
  'cmd.modeUsage': 'Usage: /mode auto|normal|conductor',
  'cmd.modeSwitched': 'Switched to {mode} mode',
  'cmd.modeUnknown':
    'Unknown mode. Choose: auto, normal, conductor (alias: cross-repo)',
  'cmd.addDir.usage': 'Usage: /add-dir <absolute or relative path>',
  'cmd.addDir.ok': 'Added workspace root id={id} path={path}',
  'cmd.addDir.fail': 'Failed to add: {error}',
  'cmd.addDir.unavailable': 'Multi-directory workspace is not enabled.',
  'cmd.dirs.empty': 'Only the primary workspace is active (no /add-dir).',
  'cmd.dirs.header': 'Session workspace directories:',
  'cmd.removeDir.usage': 'Usage: /remove-dir <id|path>',
  'cmd.removeDir.ok': 'Removed: {target}',
  'cmd.removeDir.missing': 'Not found: {target}',
  'cmd.removeDir.fail': 'Failed to remove: {error}',
  'cmd.permUsage':
    'Usage: /perm default|classifier|auto · or shift+tab to cycle',
  'cmd.permUnknown': 'Unknown permission mode. Choose: default, classifier, auto',
  'cmd.unknown': 'Unknown command: {value}. Type /help for available commands.',
  'cmd.import.detectOne': 'Detected {name} config.',
  'cmd.import.importOne':
    'Type /import {source} to import, or /import skip to dismiss.',
  'cmd.import.detectMany': 'Detected {names} configs.',
  'cmd.import.choose':
    'Choose one: /import claude or /import codex; or /import skip.',
  'cmd.asyncFailed': '{command} failed: {message}',
  'cmd.import.none': 'No Claude Code or Codex config available to import.',
  'cmd.import.skipped': 'Import skipped. Recorded at {path}',
  'cmd.import.done': 'Imported {name} config.',
  'cmd.import.configPath': 'Config file: {path}',
  'cmd.import.defaultBase': 'default',
  'cmd.import.credentialYes': 'configured',
  'cmd.import.credentialNo': 'missing',
  'cmd.import.failed': 'Import failed: {error}',
  'cmd.import.usage': 'Usage: {commands} | /import skip',
  'cmd.context.totalChars': 'Total chars: {chars}',
  'cmd.context.title': 'Context',
  'cmd.context.estimated': 'Estimated tokens',
  'cmd.context.budget': 'Input budget',
  'cmd.context.threshold': 'Compact threshold',
  'cmd.context.lastUsage': 'Last request input',
  'cmd.context.sections': 'sections (tokens):',
  'cmd.context.sources': 'sources:',
  'cmd.context.maintenance': 'Recent maintenance:',
  'cmd.context.noMaintenance': '(none)',
  'cmd.compact.done':
    'Compacted {turns} turn(s) · {before} -> {after} tokens (Stage2)',
  'cmd.compact.nothing':
    'Nothing to compact (keeping latest {preserve} full turns)',
  'cmd.compact.running': 'Compacting context…',
  'cmd.compact.busy':
    'A task or compaction is already running; context cannot be modified concurrently.',
  'cmd.lang.usage': 'Usage: /lang zh|en',
  'cmd.lang.current': 'UI language: {locale}',
  'cmd.lang.switched': 'UI language switched to {locale}',
  'cmd.lang.unknown': 'Unknown language. Choose: zh, en',
  'cmd.lang.and': ' and ',

  'context.restoredTruncated':
    'Session restored: model context keeps the latest {kept} items (incl. summary); {dropped} earlier turns were compacted.',
  'context.restoredHardTrim':
    'Session restored: model context keeps only the latest {kept} turns; {dropped} earlier turns were not loaded into the model.',
  'context.compactedNotice':
    'Context compacted: {stage}, {before} -> {after} tokens',
  'context.restoredInterrupted':
    'The previous session stopped mid-turn. Pending tool calls were cancelled; confirm the next action before continuing.'
};

export const catalogs: Record<AppLocale, Record<MessageKey, string>> = {
  zh: zhCatalog,
  en: enCatalog
};

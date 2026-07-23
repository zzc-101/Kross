import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { resolveLanguage } from './language';
import type { SupportedLanguage } from './language';

const resources = {
  'zh-CN': {
    translation: {
      common: {
        cancel: '取消',
        close: '关闭',
        confirm: '确认',
        delete: '删除',
        retry: '修改并重试',
        copy: '复制',
        copied: '已复制',
        unknown: '未知'
      },
      language: {
        label: '语言',
        zhCN: '简体中文',
        enUS: 'English'
      },
      login: {
        subtitle: '连接到你的自托管 Agent 网关',
        endpoint: '网关地址',
        token: '访问令牌',
        connecting: '正在验证…',
        connect: '安全连接',
        connectionFailed: '无法连接 Gateway'
      },
      connection: {
        online: '已连接',
        connecting: '连接中',
        outdated: '客户端版本过旧，请更新',
        reconnecting: '正在重连',
        offlineBanner: '网络已断开；操作会排队，并在恢复连接后发送。',
        updateBanner: 'Kross Cloud 有新版本可用。',
        updateAction: '更新并重新载入'
      },
      notifications: {
        gatewayNotConfigured: '网关尚未配置 Web Push',
        incompleteSubscription: '浏览器未返回完整的推送订阅'
      },
      header: {
        workspace: '工作区',
        selectWorkspace: '选择工作区',
        addWorkspace: '工作区',
        environment: '环境',
        install: '安装',
        logout: '退出'
      },
      session: {
        title: '会话',
        new: '新建会话',
        search: '搜索会话',
        empty: '没有匹配的会话。',
        emptySession: '空会话',
        actions: '会话操作 {{title}}',
        rename: '重命名',
        model: '模型',
        agentMode: 'Agent 模式',
        thinkingEffort: '思考强度',
        moreActions: '更多会话操作',
        unconfiguredModel: '未配置模型',
        more: '更多',
        inspect: '检查',
        git: 'Git',
        createPr: '创建 PR',
        enableNotifications: '启用通知',
        notifications: '通知',
        composerPlaceholder: '告诉 Kross 要完成什么…',
        stop: '停止',
        send: '发送',
        agentWorking: 'Agent 正在工作',
        you: '你',
        thinking: '思考',
        assistant: 'Kross',
        toolRecord: '工具记录',
        viewThinking: '查看思考过程',
        tool: '工具',
        viewInput: '查看输入',
        viewDetails: '查看执行明细{{suffix}}',
        truncated: '（已截断）',
        viewCall: '查看调用内容',
        step: '步骤 {{number}}',
        verification: '验证：{{status}}',
        pendingApproval: '{{tool}} 请求执行',
        planReady: '计划已就绪',
        planDetail: '确认后 Agent 将按上方计划继续执行。',
        workDir: '工作目录：{{path}}'
      },
      status: {
        awaiting: '等待中',
        running: '执行中',
        completed: '已完成',
        failed: '失败',
        denied: '已拒绝',
        cancelled: '已取消',
        approvalRequired: '等待审批',
        notRun: '未运行',
        notNeeded: '无需验证',
        passed: '已通过'
      },
      approval: {
        reject: '拒绝',
        confirmReject: '确认拒绝',
        approveOnce: '仅批准这一次',
        processing: '处理中…',
        reasonLabel: '拒绝原因',
        reasonPlaceholder: '可选：告诉 Agent 应该如何调整',
        highRisk: '高风险',
        highRiskDescription: '该操作可能造成不可逆变化，请确认范围和参数。',
        planConfirmation: '计划确认',
        confirmationRequired: '需要确认',
        planDescription: '批准后 Agent 将按此计划开始执行。',
        mediumDescription: '该操作会改变工作区，请确认后继续。',
        controlled: '受控操作',
        controlledDescription: '审批只对本次工具调用生效。'
      },
      execution: {
        idle: '尚未运行',
        completed: '执行完成',
        failed: '执行失败',
        cancelled: '已取消',
        changedFiles: '修改文件',
        verification: '验证',
        risks: '风险',
        progress: '进度',
        toolActivity: '工具活动',
        noTodos: 'Agent 创建任务后会显示在这里。'
      },
      onboarding: {
        eyebrow: 'Kross Cloud Agent',
        newSession: '开始一个新会话',
        firstWorkspace: '准备你的第一个工作区',
        sessionDescription: '会话、审批和运行记录都会保存在隔离的工作区中。',
        workspaceDescription: '先完成模型配置，再连接 Git 仓库，Kross 会创建独立执行环境。',
        configureModel: '配置模型',
        providerReady: '{{provider}} 已就绪',
        providerHint: '设置 Provider 和 API Key',
        connectRepository: '连接仓库',
        workspaceReady: '工作区已经就绪',
        repositoryHint: '公开或私有 Git 仓库',
        createTask: '创建任务',
        taskHint: '让 Agent 分析、修改并验证代码'
      },
      workspace: {
        dialogEyebrow: '工作区',
        add: '添加工作区',
        description: '仓库会克隆到独立数据卷，创建过程可随时查看阶段进度。',
        name: '名称',
        gitUrl: 'Git URL',
        defaultBranch: '默认分支（可选）',
        autoDetect: '自动检测',
        credential: '仓库凭证',
        publicRepository: '公开仓库 / 无凭证',
        httpsToken: 'HTTPS Token',
        sshKey: 'SSH 私钥',
        token: 'Token',
        privateKey: '私钥',
        credentialNote: '凭证仅发送给对应工作区的初始化容器，不写入网关日志。',
        create: '创建工作区',
        start: '启动',
        stop: '停止',
        statusReady: '运行中',
        statusStopped: '已停止',
        statusCreating: '创建中',
        statusError: '异常',
        provisioning: 'Workspace Provisioning',
        stageValidate: '校验仓库',
        stagePrepare: '准备环境',
        stageClone: '克隆代码',
        stageStart: '启动 Worker',
        stageReady: '工作区就绪',
        progressLabel: '工作区创建进度',
        createFailed: '创建失败。请检查仓库地址、分支和凭据后重试。',
        enter: '进入工作区',
        validation: {
          tokenWithSsh: 'HTTPS Token 不能用于 SSH 仓库地址',
          protocol: '仅支持 HTTPS 或 SSH Git 地址',
          embeddedCredential: 'Git URL 不能内嵌凭据，请使用下方凭据字段',
          tokenProtocol: 'HTTPS Token 只能用于 https:// 地址',
          sshProtocol: 'SSH 私钥需要 ssh://、git+ssh:// 或 scp 风格地址',
          completeUrl: '请输入完整的 HTTPS、SSH 或 scp 风格 Git 地址',
          tokenRequired: '请输入 HTTPS Token',
          keyRequired: '请输入 SSH 私钥',
          invalidKey: 'SSH 私钥格式不正确'
        }
      },
      navigation: {
        sessions: '会话',
        chat: '对话',
        progress: '进度'
      },
      inspection: {
        eyebrow: 'Session Inspection',
        diffTitle: '工作区 Diff',
        traceTitle: '运行 Trace',
        diffDescription: '检查当前工作区尚未提交的代码变化。',
        traceDescription: '查看 Agent 运行事件和工具调用轨迹。',
        noChanges: '没有 Git 变更',
        staged: '已暂存变更',
        unstaged: '未暂存变更',
        recentRuns: '最近运行'
        ,
        stagedHeading: '# 已暂存变更',
        unstagedHeading: '# 未暂存变更'
      },
      setup: {
        eyebrow: '环境与模型',
        title: '运行环境检查',
        description: '确认 Agent 执行所需的基础能力，并安全配置模型。',
        passed: '正常',
        failed: '异常',
        warning: '注意',
        checking: '正在检查运行环境…',
        provider: 'Provider',
        modelConfig: '模型配置',
        keyNotice: 'API Key 仅写入 Gateway 的私有配置文件，界面不会回显。',
        providerLabel: '服务商',
        modelId: '模型 ID',
        baseUrl: 'Base URL（可选）',
        baseUrlPlaceholder: '使用服务商默认地址',
        keyConfigured: '已配置；留空表示保持不变',
        keyRequired: '请输入 API Key',
        restartWorkers: '重建现有 Worker 以立即应用配置',
        restartHint: '保留仓库和会话卷，运行中的任务会被中断。',
        saving: '正在保存…',
        save: '保存配置',
        savedWithWorkers: '配置已保存，并重建了 {{count}} 个 Worker',
        saved: '配置已安全保存，新建 Worker 将立即使用'
      },
      operation: {
        brand: 'Kross Cloud',
        deleteSessionWarning: '即将永久删除会话“{{title}}”及其执行记录，此操作无法撤销。',
        deleteWorkspaceWarning: '即将删除工作区“{{name}}”的 Worker 和登记信息。',
        removeVolume: '同时永久删除工作区数据卷',
        removeVolumeHint: '仓库、会话和审批记录将无法恢复。',
        keepVolume: '数据卷会保留，后续仍可人工恢复。',
        confirmDelete: '确认删除',
        sessionName: '会话名称',
        modelId: '模型 ID',
        selectModel: '选择模型',
        branch: '分支',
        sourceBranch: '源分支',
        targetBranch: '目标分支',
        prTitle: 'PR 标题',
        prBody: 'PR 描述（可选）',
        renameSession: '重命名会话',
        deleteSession: '删除会话',
        switchModel: '切换模型',
        pushBranch: '推送分支',
        createPr: '创建 Pull Request',
        deleteWorkspace: '删除工作区',
        renameDescription: '为当前会话设置一个更容易识别的名称。',
        modelDescription: '选择后将应用到当前会话。',
        pushDescription: '将当前工作区分支推送到远程仓库。',
        prDescription: '从当前工作区创建新的 Pull Request。'
      }
    }
  },
  'en-US': {
    translation: {
      common: {
        cancel: 'Cancel',
        close: 'Close',
        confirm: 'Confirm',
        delete: 'Delete',
        retry: 'Edit and retry',
        copy: 'Copy',
        copied: 'Copied',
        unknown: 'Unknown'
      },
      language: {
        label: 'Language',
        zhCN: '简体中文',
        enUS: 'English'
      },
      login: {
        subtitle: 'Connect to your self-hosted Agent gateway',
        endpoint: 'Gateway URL',
        token: 'Access token',
        connecting: 'Verifying…',
        connect: 'Connect securely',
        connectionFailed: 'Unable to connect to Gateway'
      },
      connection: {
        online: 'Connected',
        connecting: 'Connecting',
        outdated: 'Client is outdated. Please update.',
        reconnecting: 'Reconnecting',
        offlineBanner: 'You are offline. Actions will be queued until the connection returns.',
        updateBanner: 'A new Kross Cloud version is available.',
        updateAction: 'Update and reload'
      },
      notifications: {
        gatewayNotConfigured: 'Web Push is not configured on the Gateway',
        incompleteSubscription: 'The browser returned an incomplete push subscription'
      },
      header: {
        workspace: 'Workspace',
        selectWorkspace: 'Select workspace',
        addWorkspace: 'Workspace',
        environment: 'Environment',
        install: 'Install',
        logout: 'Log out'
      },
      session: {
        title: 'Sessions',
        new: 'New session',
        search: 'Search sessions',
        empty: 'No matching sessions.',
        emptySession: 'Empty session',
        actions: 'Session actions for {{title}}',
        rename: 'Rename',
        model: 'Model',
        agentMode: 'Agent mode',
        thinkingEffort: 'Thinking effort',
        moreActions: 'More session actions',
        unconfiguredModel: 'Model not configured',
        more: 'More',
        inspect: 'Inspect',
        git: 'Git',
        createPr: 'Create PR',
        enableNotifications: 'Enable notifications',
        notifications: 'Notifications',
        composerPlaceholder: 'Tell Kross what to accomplish…',
        stop: 'Stop',
        send: 'Send',
        agentWorking: 'Agent is working',
        you: 'You',
        thinking: 'Thinking',
        assistant: 'Kross',
        toolRecord: 'Tool record',
        viewThinking: 'View reasoning',
        tool: 'Tool',
        viewInput: 'View input',
        viewDetails: 'View execution details{{suffix}}',
        truncated: ' (truncated)',
        viewCall: 'View call content',
        step: 'Step {{number}}',
        verification: 'Verification: {{status}}',
        pendingApproval: '{{tool}} requests approval',
        planReady: 'Plan ready',
        planDetail: 'Once approved, the Agent will continue with the plan above.',
        workDir: 'Working directory: {{path}}'
      },
      status: {
        awaiting: 'Waiting',
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        denied: 'Denied',
        cancelled: 'Cancelled',
        approvalRequired: 'Awaiting approval',
        notRun: 'Not run',
        notNeeded: 'Not needed',
        passed: 'Passed'
      },
      approval: {
        reject: 'Reject',
        confirmReject: 'Confirm rejection',
        approveOnce: 'Approve once',
        processing: 'Processing…',
        reasonLabel: 'Rejection reason',
        reasonPlaceholder: 'Optional: tell the Agent how to adjust',
        highRisk: 'High risk',
        highRiskDescription: 'This action may cause irreversible changes. Verify its scope and parameters.',
        planConfirmation: 'Plan confirmation',
        confirmationRequired: 'Confirmation required',
        planDescription: 'Once approved, the Agent will begin executing this plan.',
        mediumDescription: 'This action changes the workspace. Confirm to continue.',
        controlled: 'Controlled action',
        controlledDescription: 'This approval applies only to this tool call.'
      },
      execution: {
        idle: 'Not started',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled',
        changedFiles: 'Changed files',
        verification: 'Verification',
        risks: 'Risks',
        progress: 'Progress',
        toolActivity: 'Tool activity',
        noTodos: 'Tasks will appear here after the Agent creates them.'
      },
      onboarding: {
        eyebrow: 'Kross Cloud Agent',
        newSession: 'Start a new session',
        firstWorkspace: 'Prepare your first workspace',
        sessionDescription: 'Sessions, approvals, and run history are stored in the isolated workspace.',
        workspaceDescription: 'Configure a model, then connect a Git repository to create an isolated environment.',
        configureModel: 'Configure model',
        providerReady: '{{provider}} is ready',
        providerHint: 'Set a provider and API key',
        connectRepository: 'Connect repository',
        workspaceReady: 'Workspace is ready',
        repositoryHint: 'Public or private Git repository',
        createTask: 'Create task',
        taskHint: 'Let the Agent analyze, modify, and verify code'
      },
      workspace: {
        dialogEyebrow: 'Workspace',
        add: 'Add workspace',
        description: 'The repository is cloned into an isolated volume with visible provisioning progress.',
        name: 'Name',
        gitUrl: 'Git URL',
        defaultBranch: 'Default branch (optional)',
        autoDetect: 'Auto-detect',
        credential: 'Repository credential',
        publicRepository: 'Public repository / no credential',
        httpsToken: 'HTTPS token',
        sshKey: 'SSH private key',
        token: 'Token',
        privateKey: 'Private key',
        credentialNote: 'Credentials are sent only to the workspace initializer and are not written to Gateway logs.',
        create: 'Create workspace',
        start: 'Start',
        stop: 'Stop',
        statusReady: 'Running',
        statusStopped: 'Stopped',
        statusCreating: 'Creating',
        statusError: 'Error',
        provisioning: 'Workspace Provisioning',
        stageValidate: 'Validate repository',
        stagePrepare: 'Prepare environment',
        stageClone: 'Clone code',
        stageStart: 'Start Worker',
        stageReady: 'Workspace ready',
        progressLabel: 'Workspace creation progress',
        createFailed: 'Creation failed. Check the repository URL, branch, and credentials, then retry.',
        enter: 'Enter workspace',
        validation: {
          tokenWithSsh: 'HTTPS tokens cannot be used with SSH repository URLs',
          protocol: 'Only HTTPS or SSH Git URLs are supported',
          embeddedCredential: 'Do not embed credentials in the Git URL; use the credential fields below',
          tokenProtocol: 'HTTPS tokens require an https:// URL',
          sshProtocol: 'SSH keys require an ssh://, git+ssh://, or SCP-style URL',
          completeUrl: 'Enter a complete HTTPS, SSH, or SCP-style Git URL',
          tokenRequired: 'Enter an HTTPS token',
          keyRequired: 'Enter an SSH private key',
          invalidKey: 'The SSH private key format is invalid'
        }
      },
      navigation: {
        sessions: 'Sessions',
        chat: 'Chat',
        progress: 'Progress'
      },
      inspection: {
        eyebrow: 'Session Inspection',
        diffTitle: 'Workspace Diff',
        traceTitle: 'Run Trace',
        diffDescription: 'Inspect uncommitted changes in the current workspace.',
        traceDescription: 'Review Agent events and tool call traces.',
        noChanges: 'No Git changes',
        staged: 'Staged changes',
        unstaged: 'Unstaged changes',
        recentRuns: 'Recent runs'
        ,
        stagedHeading: '# Staged changes',
        unstagedHeading: '# Unstaged changes'
      },
      setup: {
        eyebrow: 'Environment & Model',
        title: 'Runtime checks',
        description: 'Verify the capabilities required by the Agent and configure a model securely.',
        passed: 'Passed',
        failed: 'Failed',
        warning: 'Warning',
        checking: 'Checking the runtime environment…',
        provider: 'Provider',
        modelConfig: 'Model configuration',
        keyNotice: 'The API key is stored only in the private Gateway configuration and is never displayed.',
        providerLabel: 'Provider',
        modelId: 'Model ID',
        baseUrl: 'Base URL (optional)',
        baseUrlPlaceholder: 'Use the provider default',
        keyConfigured: 'Configured; leave blank to keep it unchanged',
        keyRequired: 'Enter an API key',
        restartWorkers: 'Recreate existing Workers to apply now',
        restartHint: 'Repository and session volumes are preserved; running tasks will be interrupted.',
        saving: 'Saving…',
        save: 'Save configuration',
        savedWithWorkers: 'Configuration saved and {{count}} Workers recreated',
        saved: 'Configuration saved securely; new Workers will use it immediately'
      },
      operation: {
        brand: 'Kross Cloud',
        deleteSessionWarning: 'Session “{{title}}” and its run history will be permanently deleted. This cannot be undone.',
        deleteWorkspaceWarning: 'Workspace “{{name}}”, its Worker, and registration will be deleted.',
        removeVolume: 'Also permanently delete the workspace volume',
        removeVolumeHint: 'Repositories, sessions, and approval records cannot be recovered.',
        keepVolume: 'The data volume will be kept for manual recovery.',
        confirmDelete: 'Confirm deletion',
        sessionName: 'Session name',
        modelId: 'Model ID',
        selectModel: 'Select model',
        branch: 'Branch',
        sourceBranch: 'Source branch',
        targetBranch: 'Target branch',
        prTitle: 'PR title',
        prBody: 'PR description (optional)',
        renameSession: 'Rename session',
        deleteSession: 'Delete session',
        switchModel: 'Switch model',
        pushBranch: 'Push branch',
        createPr: 'Create Pull Request',
        deleteWorkspace: 'Delete workspace',
        renameDescription: 'Give the current session a more recognizable name.',
        modelDescription: 'The selected model will be applied to the current session.',
        pushDescription: 'Push the current workspace branch to the remote repository.',
        prDescription: 'Create a Pull Request from the current workspace.'
      }
    }
  }
} as const;

function initialLanguage(): SupportedLanguage {
  return resolveLanguage(
    localStorage.getItem('kross.language'),
    navigator.language
  );
}

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage(),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false }
  });

function applyDocumentLanguage(language: string) {
  document.documentElement.lang = language;
}

applyDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on('languageChanged', (language) => {
  localStorage.setItem('kross.language', language);
  applyDocumentLanguage(language);
});

export default i18n;

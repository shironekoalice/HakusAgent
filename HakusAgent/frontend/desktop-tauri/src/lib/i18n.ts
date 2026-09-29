import { create } from 'zustand'

export type AppLanguage = 'system' | 'zh-CN' | 'en-US'
export type ResolvedLocale = 'zh-CN' | 'en-US'

export const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; labelZh: string; labelEn: string }> = [
  { value: 'system', labelZh: '跟随系统', labelEn: 'System' },
  { value: 'zh-CN', labelZh: '简体中文', labelEn: 'Simplified Chinese' },
  { value: 'en-US', labelZh: 'English', labelEn: 'English' },
]

export function languageOptionLabel(
  option: (typeof LANGUAGE_OPTIONS)[number],
  locale: ResolvedLocale,
): string {
  return locale === 'zh-CN' ? option.labelZh : option.labelEn
}

export function detectSystemLocale(): ResolvedLocale {
  if (typeof navigator === 'undefined') return 'en-US'
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ]
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    // Some embedded WebViews expose Intl incompletely; navigator is enough.
  }
  return candidates.some((language) => String(language || '').toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : 'en-US'
}

export function resolveLocale(language: AppLanguage | string | undefined): ResolvedLocale {
  if (language === 'zh-CN' || language === 'zh-Hans' || language === 'zh') return 'zh-CN'
  if (language === 'en-US' || language === 'en') return 'en-US'
  return detectSystemLocale()
}

type MessageKey =
  | 'settings'
  | 'settingsCategory'
  | 'backToChat'
  | 'closeSidebar'
  | 'toggleSidebar'
  | 'reviewPanel'
  | 'reviewTab'
  | 'trajectoryTab'
  | 'terminalTab'
  | 'browserTab'
  | 'logsTab'
  | 'usageTab'
  | 'goalTab'
  | 'worktreeTab'
  | 'filesTab'
  | 'artifactTab'
  | 'openInPanel'
  | 'copyLabel'
  | 'workbench'
  | 'clearChat'
  | 'minimize'
  | 'maximize'
  | 'close'
  | 'workMode'
  | 'codeMode'
  | 'flowMode'
  | 'flowRunTab'
  | 'awaitingModel'
  | 'welcomeTitle'
  | 'welcomeHint'
  | 'connectionUnavailable'
  | 'retry'
  | 'startChat'
  | 'helloHakus'
  | 'readyToWorkPrefix'
  | 'readyToWorkSuffix'
  | 'currentDirectory'
  | 'starterBuild'
  | 'starterBuildPrompt'
  | 'starterReview'
  | 'starterReviewPrompt'
  | 'starterExplore'
  | 'starterExplorePrompt'
  | 'starterFix'
  | 'starterFixPrompt'
  | 'searchSessions'
  | 'noMatches'
  | 'noSessions'
  | 'noMessages'
  | 'newChat'
  | 'moreActions'
  | 'rename'
  | 'cancel'
  | 'confirm'
  | 'experimental'
  | 'experimentalSuffix'
  | 'flowBetaNotice'
  | 'pin'
  | 'unpin'
  | 'delete'
  | 'deleted'
  | 'deleteFailed'
  | 'appearance'
  | 'appearanceDesc'
  | 'language'
  | 'languageDescription'
  | 'systemLanguage'
  | 'light'
  | 'dark'
  | 'followSystem'
  | 'theme'
  | 'chatFontSize'
  | 'preview'
  | 'firstRunTitle'
  | 'firstRunSubtitle'
  | 'stepOf'
  | 'firstRunLanguageTitle'
  | 'firstRunLanguageDescription'
  | 'firstRunWorkspaceTitle'
  | 'firstRunWorkspaceDescription'
  | 'chooseFolder'
  | 'changeFolder'
  | 'folderChosen'
  | 'skip'
  | 'continue'
  | 'finish'
  | 'readyTitle'
  | 'readyDescription'
  | 'setupLater'
  | 'workspace'
  | 'workspaceNotSelected'
  | 'projectCreateFailed'
  | 'saveLanguageFailed'
  | 'modelConfig'
  | 'character'
  | 'chat'
  | 'voice'
  | 'memory'
  | 'tools'
  | 'skills'
  | 'tray'
  | 'mcp'
  | 'wechat'
  | 'projects'
  | 'connection'
  | 'advanced'
  | 'about'
  | 'modelDesc'
  | 'characterDesc'
  | 'chatDesc'
  | 'voiceDesc'
  | 'memoryDesc'
  | 'toolsDesc'
  | 'automations'
  | 'automationsDesc'
  | 'skillsDesc'
  | 'trayDesc'
  | 'mcpDesc'
  | 'wechatDesc'
  | 'projectsDesc'
  | 'connectionDesc'
  | 'advancedDesc'
  | 'aboutDesc'
  | 'settingsGeneral'
  | 'settingsModels'
  | 'settingsWorkspaceData'
  | 'settingsToolsIntegrations'
  | 'settingsAppearanceAbout'

const messages: Record<ResolvedLocale, Record<MessageKey, string>> = {
  'zh-CN': {
    settings: '设置', settingsCategory: '设置分类', backToChat: '返回聊天', closeSidebar: '关闭侧栏',
    toggleSidebar: '切换侧栏', reviewPanel: '审阅 / 终端面板', reviewTab: '审阅', trajectoryTab: '轨迹', terminalTab: '终端', browserTab: '浏览器', logsTab: '日志', usageTab: '用量', goalTab: '目标', worktreeTab: 'Worktree', filesTab: '文件', artifactTab: '文档', openInPanel: '在侧栏打开', copyLabel: '复制', workbench: '工作台', clearChat: '清空对话', minimize: '最小化',
    maximize: '最大化 / 还原', close: '关闭', workMode: 'Work', codeMode: 'Code', flowMode: 'Flow', flowRunTab: 'Flow', awaitingModel: '等待模型信息',
    welcomeTitle: '欢迎使用 HakusAI', welcomeHint: '点击侧栏的 + 开始新对话', startChat: '开始新对话', connectionUnavailable: '无法连接到 HakusAI 服务', retry: '重试',
    helloHakus: '你好，我是 HakusAI', readyToWorkPrefix: '准备好在', readyToWorkSuffix: '里开工了。构建新功能、审查代码、探索代码库，或修复问题，选一个开始吧。', currentDirectory: '当前目录',
    starterBuild: '构建新功能', starterBuildPrompt: '帮我构建一个新功能、应用或工具', starterReview: '审查代码', starterReviewPrompt: '请审查代码并提出修改建议', starterExplore: '探索代码库', starterExplorePrompt: '探索并理解这个代码库的整体结构', starterFix: '修复问题', starterFixPrompt: '帮我修复一个 bug 或失败的测试',
    searchSessions: '搜索会话...', noMatches: '无匹配结果', noSessions: '暂无会话', noMessages: '暂无消息',
    newChat: '新对话', moreActions: '更多操作', rename: '重命名', cancel: '取消', confirm: '确定', experimental: '实验', experimentalSuffix: '（实验性功能）', flowBetaNotice: 'Flow 模式为实验性功能：画布与节点仍在快速迭代，数据保存在本机浏览器存储中，格式可能随版本变化。', pin: '置顶', unpin: '取消置顶', delete: '删除',
    deleted: '会话已删除', deleteFailed: '删除失败', appearance: '外观', language: '语言',
    languageDescription: '界面语言。选择跟随系统时，Android 会使用系统语言，桌面端首次启动也可重新选择。',
    systemLanguage: '跟随系统', light: '浅色', dark: '深色', followSystem: '跟随系统', theme: '主题',
    chatFontSize: '聊天字体大小', preview: '预览', firstRunTitle: '欢迎使用 HakusAI',
    firstRunSubtitle: '先完成两个小设置，之后可以随时在设置中修改。', stepOf: '第 {step} 步，共 {total} 步', firstRunLanguageTitle: '选择界面语言',
    firstRunLanguageDescription: '桌面端可手动选择；Android 默认跟随系统语言。', firstRunWorkspaceTitle: '选择工作区',
    firstRunWorkspaceDescription: '选择一个项目文件夹，让 HakusAI 在这个目录中工作。也可以稍后设置。', chooseFolder: '选择文件夹', changeFolder: '更换文件夹',
    folderChosen: '已选择', skip: '稍后设置', continue: '继续', finish: '开始使用', readyTitle: '准备好了',
    readyDescription: '你可以直接开始对话，也可以在设置中添加模型商和 API Key。', setupLater: '这些设置以后都能修改。',
    workspace: '工作区', workspaceNotSelected: '未选择（使用默认目录）', projectCreateFailed: '工作区保存失败，请稍后在设置中重试。',
    saveLanguageFailed: '语言设置保存失败，请稍后重试。',
    modelConfig: '模型配置', character: '角色', chat: '对话', voice: '语音通话与播报', memory: '记忆',
    tools: '工具与权限', automations: '定时任务', skills: 'Skills', tray: '托盘与快捷键', mcp: 'MCP 服务器', wechat: '微信', projects: '项目',
    connection: '连接', advanced: '高级', about: '关于与更新',
    modelDesc: 'AI Provider 与 API Key', characterDesc: '人格与开场白', chatDesc: '发送行为与显示', appearanceDesc: '主题与字体',
    voiceDesc: 'Celia 通话、任务播报与提示音', memoryDesc: '短期与长期记忆', toolsDesc: '工具开关与权限模式',
    skillsDesc: '安装、启用与管理任务能力', automationsDesc: '定时触发 Agent 执行周期任务', trayDesc: '任务栏图标与全局快捷键', mcpDesc: '外部 MCP server 接入与工具调用',
    wechatDesc: 'ClawBot 扫码连接', projectsDesc: '文件夹注册表：添加、重命名、置顶与移除', connectionDesc: '服务地址与超时',
    advancedDesc: '诊断、导入导出与重启', aboutDesc: '版本信息与自动更新',
    settingsGeneral: '通用', settingsModels: '模型与模型商', settingsWorkspaceData: '工作区与数据', settingsToolsIntegrations: '工具与集成', settingsAppearanceAbout: '外观与关于',
  },
  'en-US': {
    settings: 'Settings', settingsCategory: 'Settings categories', backToChat: 'Back to chat', closeSidebar: 'Close sidebar',
    toggleSidebar: 'Toggle sidebar', reviewPanel: 'Review / terminal panel', reviewTab: 'Review', trajectoryTab: 'Activity', terminalTab: 'Terminal', browserTab: 'Browser', logsTab: 'Logs', usageTab: 'Usage', goalTab: 'Goal', worktreeTab: 'Worktree', filesTab: 'Files', artifactTab: 'Document', openInPanel: 'Open in panel', copyLabel: 'Copy', workbench: 'Workbench', clearChat: 'Clear chat', minimize: 'Minimize',
    maximize: 'Maximize / restore', close: 'Close', workMode: 'Work', codeMode: 'Code', flowMode: 'Flow', flowRunTab: 'Flow', awaitingModel: 'Waiting for model',
    welcomeTitle: 'Welcome to HakusAI', welcomeHint: 'Click + in the sidebar to start a new chat', startChat: 'Start a new chat', connectionUnavailable: 'HakusAI service is unavailable', retry: 'Retry',
    helloHakus: "Hi, I'm HakusAI", readyToWorkPrefix: 'Ready to work in', readyToWorkSuffix: '. Build a feature, review code, explore the repository, or fix a bug.', currentDirectory: 'Current directory',
    starterBuild: 'Build a feature', starterBuildPrompt: 'Build a new feature, app, or tool for me', starterReview: 'Review code', starterReviewPrompt: 'Review the code and suggest improvements', starterExplore: 'Explore the repository', starterExplorePrompt: 'Explore and understand the overall structure of this repository', starterFix: 'Fix a problem', starterFixPrompt: 'Fix a bug or a failing test for me',
    searchSessions: 'Search conversations...', noMatches: 'No matches', noSessions: 'No conversations yet', noMessages: 'No messages yet',
    newChat: 'New chat', moreActions: 'More actions', rename: 'Rename', cancel: 'Cancel', confirm: 'OK', experimental: 'Beta', experimentalSuffix: ' (experimental)', flowBetaNotice: 'Flow mode is experimental: the canvas and nodes are still evolving. Graphs are stored in local browser storage and their format may change between versions.', pin: 'Pin', unpin: 'Unpin', delete: 'Delete',
    deleted: 'Conversation deleted', deleteFailed: 'Delete failed', appearance: 'Appearance', language: 'Language',
    languageDescription: 'Interface language. System follows Android language automatically and can be changed on desktop during first launch.',
    systemLanguage: 'System', light: 'Light', dark: 'Dark', followSystem: 'System', theme: 'Theme',
    chatFontSize: 'Chat font size', preview: 'Preview', firstRunTitle: 'Welcome to HakusAI',
    firstRunSubtitle: 'Take a moment to set up the basics. You can change them later in Settings.', stepOf: 'Step {step} of {total}', firstRunLanguageTitle: 'Choose a language',
    firstRunLanguageDescription: 'Desktop lets you choose manually; Android follows the system language by default.', firstRunWorkspaceTitle: 'Choose a workspace',
    firstRunWorkspaceDescription: 'Pick a project folder for HakusAI to work in. You can also do this later.', chooseFolder: 'Choose folder', changeFolder: 'Change folder',
    folderChosen: 'Selected', skip: 'Set up later', continue: 'Continue', finish: 'Get started', readyTitle: 'You are ready',
    readyDescription: 'Start a conversation now, or add providers and API keys later in Settings.', setupLater: 'You can change these settings later.',
    workspace: 'Workspace', workspaceNotSelected: 'Not selected (use the default directory)', projectCreateFailed: 'Could not save the workspace. Try again in Settings.',
    saveLanguageFailed: 'Could not save the language. Please try again.',
    modelConfig: 'Models', character: 'Character', chat: 'Chat', voice: 'Voice & broadcasts', memory: 'Memory',
    tools: 'Tools & permissions', automations: 'Automations', skills: 'Skills', tray: 'Tray & shortcuts', mcp: 'MCP servers', wechat: 'WeChat', projects: 'Projects',
    connection: 'Connection', advanced: 'Advanced', about: 'About & updates',
    modelDesc: 'AI providers and API keys', characterDesc: 'Personality and greeting', chatDesc: 'Sending and display', appearanceDesc: 'Theme and typography',
    voiceDesc: 'Celia calls, broadcasts, and sounds', memoryDesc: 'Short- and long-term memory', toolsDesc: 'Tool switches and permission mode',
    skillsDesc: 'Install, enable, and manage capabilities', automationsDesc: 'Run the agent on a schedule', trayDesc: 'Taskbar icon and global shortcut', mcpDesc: 'External MCP servers and tools',
    wechatDesc: 'ClawBot QR connection', projectsDesc: 'Folder registry: add, rename, pin, and remove', connectionDesc: 'Server address and timeout',
    advancedDesc: 'Diagnostics, import/export, and restart', aboutDesc: 'Version information and updates',
    settingsGeneral: 'General', settingsModels: 'Models & providers', settingsWorkspaceData: 'Workspace & data', settingsToolsIntegrations: 'Tools & integrations', settingsAppearanceAbout: 'Appearance & about',
  },
}

export function translate(locale: ResolvedLocale, key: MessageKey): string {
  return messages[locale][key] || messages['en-US'][key] || key
}

interface LocaleStore {
  language: AppLanguage
  locale: ResolvedLocale
  setLanguage: (language: AppLanguage) => void
  initialize: (language?: AppLanguage | string) => void
}

export const useLocaleStore = create<LocaleStore>((set) => ({
  language: 'system',
  locale: detectSystemLocale(),
  setLanguage: (language) => set({ language, locale: resolveLocale(language) }),
  initialize: (language = 'system') => set({ language: normalizeLanguage(language), locale: resolveLocale(language) }),
}))

export function useI18n() {
  const locale = useLocaleStore((state) => state.locale)
  return { locale, t: (key: MessageKey) => translate(locale, key) }
}

export function normalizeLanguage(value: unknown): AppLanguage {
  if (value === 'zh-CN' || value === 'en-US') return value
  return 'system'
}

export function localeForRuntime(locale: ResolvedLocale): string {
  return locale === 'zh-CN' ? 'zh-Hans' : 'en-US'
}

export type { MessageKey }

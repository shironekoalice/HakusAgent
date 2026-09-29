/**
 * Projects store — local projects plus remote projects managed by the desktop shell.
 *
 * A project is just a named folder on disk. The user picks a folder via
 * the Tauri folder dialog, we register it on the server, and the active
 * project's id is sent with every chat turn so the agent runs inside
 * that folder.
 *
 * The "active project" is per-session-ish: we persist it to localStorage
 * so it survives page refresh, but it's not strictly per-session — the
 * user can switch it any time from the Composer's picker. The chat
 * request carries the current value at send time, so there's no need
 * to sync it back to the session store.
 */
import { create } from 'zustand'
import { apiClient } from '@/api/client'
import { loadRemoteProjects, remoteConnectionForProject, remoteOs, saveRemoteProjects, type RemoteRuntimeResult } from '@/api/tauriBridge'
import type { Project, ProjectCreateBody } from '@/api/types'

const ACTIVE_PROJECT_KEY = 'hakusai-active-project-id'
export const REMOTE_RECONNECT_EVENT = 'hakus:remote-project-reconnect'
export const REMOTE_RUNTIME_CONNECTED_EVENT = 'hakus:remote-runtime-connected'

interface ProjectsStore {
  projects: Project[]
  remoteProjects: Project[]
  /** Loaded flag — false until first successful listProjects(). */
  loaded: boolean
  /** Currently active project id (null = "不在项目中工作"). */
  activeProjectId: string | null
  /** Convenience: the full Project object for activeProjectId, or null. */
  activeProject: Project | null
  remoteRuntimes: Record<string, RemoteRuntimeResult>

  load: () => Promise<void>
  setActive: (projectId: string | null) => boolean
  create: (body: ProjectCreateBody) => Promise<Project>
  createRemote: (project: Project) => Promise<Project>
  connectRemoteRuntime: (project: Project, password?: string) => Promise<RemoteRuntimeResult>
  isRemoteRuntimeReady: (projectId: string) => boolean
  renameRemote: (projectId: string, name: string) => Promise<void>
  togglePinnedRemote: (projectId: string, pinned: boolean) => Promise<void>
  rename: (projectId: string, name: string) => Promise<void>
  togglePinned: (projectId: string, pinned: boolean) => Promise<void>
  remove: (projectId: string) => Promise<void>
  removeRemote: (projectId: string) => Promise<void>
}

function readActiveFromStorage(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY) || null
  } catch {
    return null
  }
}

function writeActiveToStorage(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  } catch {
    /* ignore quota / privacy mode errors */
  }
}

function findActive(projects: Project[], id: string | null): Project | null {
  if (!id) return null
  return projects.find((p) => p.id === id) || null
}

function requestRemoteReconnect(project: Project): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REMOTE_RECONNECT_EVENT, { detail: project }))
  }
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  remoteProjects: [],
  loaded: false,
  activeProjectId: readActiveFromStorage(),
  activeProject: null,
  remoteRuntimes: {},

  load: async () => {
    try {
      const [projects, remoteProjects] = await Promise.all([
        apiClient.listProjects(),
        loadRemoteProjects(),
      ])
      const activeId = get().activeProjectId
      // If the persisted active id is no longer in the registry
      // (deleted from another device / hand-edited projects.json),
      // fall back to null — don't silently keep sending a stale id.
      const registry = [...projects, ...remoteProjects]
      const stillExists = activeId ? registry.some((p) => p.id === activeId) : false
      let nextActiveId = stillExists ? activeId : null
      const activeProject = findActive(registry, nextActiveId)
      const reconnectProject = activeProject?.kind === 'remote' ? activeProject : null
      if (reconnectProject) nextActiveId = null
      if (!stillExists) writeActiveToStorage(null)
      if (reconnectProject) writeActiveToStorage(null)
      set({
        projects: registry,
        remoteProjects,
        loaded: true,
        activeProjectId: nextActiveId,
        activeProject: findActive(registry, nextActiveId),
      })
      if (reconnectProject) requestRemoteReconnect(reconnectProject)
    } catch (e) {
      // Don't crash the UI if /api/projects is unavailable (e.g. backend
      // too old). The picker will just show an empty list + "新建项目".
      console.warn('[projects] load failed:', e)
      set({ loaded: true })
    }
  },

  setActive: (projectId) => {
    const previousId = get().activeProjectId
    const projects = get().projects
    const project = findActive(projects, projectId)
    if (project?.kind === 'remote') {
      const runtime = get().remoteRuntimes[project.id]
      if (!runtime) {
        requestRemoteReconnect(project)
        return false
      }
      apiClient.setRemoteRuntime(`http://127.0.0.1:${runtime.localPort}`, runtime.runtimeToken)
      apiClient.setRuntimeProjectPath(project.id, project.path)
    } else {
      apiClient.useLocalRuntime()
    }
    writeActiveToStorage(projectId)
    set({
      activeProjectId: projectId,
      activeProject: project,
    })
    if (previousId && previousId !== projectId && get().remoteRuntimes[previousId]) {
      const remoteRuntimes = { ...get().remoteRuntimes }
      delete remoteRuntimes[previousId]
      set({ remoteRuntimes })
      void remoteOs.stopRuntime(previousId).catch((error) => {
        console.warn('[projects] previous remote runtime stop failed:', error)
      })
    }
    return true
  },

  create: async (body) => {
    const project = await apiClient.createProject(body)
    const projects = [project, ...get().projects.filter((p) => p.id !== project.id)]
    set({ projects })
    return project
  },

  createRemote: async (project) => {
    const remoteProjects = [
      { ...project, kind: 'remote' as const },
      ...get().remoteProjects.filter((candidate) => candidate.id !== project.id),
    ]
    await saveRemoteProjects(remoteProjects)
    set({ remoteProjects, projects: [project, ...get().projects.filter((candidate) => candidate.id !== project.id)] })
    return project
  },

  connectRemoteRuntime: async (project, password) => {
    const previousId = get().activeProjectId
    const connection = remoteConnectionForProject(project)
    if (!connection) throw new Error('远程项目缺少连接配置')
    const result = await remoteOs.startRuntime(
      project.id,
      { ...connection, password: password || undefined },
      project.path,
      project.remote?.installMode,
    )
    apiClient.setRemoteRuntime(`http://127.0.0.1:${result.localPort}`, result.runtimeToken)
    apiClient.setRuntimeProjectPath(project.id, project.path)
    writeActiveToStorage(project.id)
    set({
      activeProjectId: project.id,
      activeProject: project,
      remoteRuntimes: { ...get().remoteRuntimes, [project.id]: result },
    })
    if (previousId && previousId !== project.id && get().remoteRuntimes[previousId]) {
      const remoteRuntimes = { ...get().remoteRuntimes }
      delete remoteRuntimes[previousId]
      set({ remoteRuntimes })
      void remoteOs.stopRuntime(previousId).catch((error) => {
        console.warn('[projects] previous remote runtime stop failed:', error)
      })
    }
    return result
  },

  isRemoteRuntimeReady: (projectId) => Boolean(get().remoteRuntimes[projectId]),

  renameRemote: async (projectId, name) => {
    const remoteProjects = get().remoteProjects.map((project) =>
      project.id === projectId ? { ...project, name } : project,
    )
    await saveRemoteProjects(remoteProjects)
    set({ remoteProjects, projects: get().projects.map((project) => project.id === projectId ? remoteProjects.find((item) => item.id === projectId) || project : project) })
  },

  togglePinnedRemote: async (projectId, pinned) => {
    const remoteProjects = get().remoteProjects.map((project) =>
      project.id === projectId ? { ...project, pinned } : project,
    )
    await saveRemoteProjects(remoteProjects)
    set({ remoteProjects, projects: get().projects.map((project) => project.id === projectId ? remoteProjects.find((item) => item.id === projectId) || project : project) })
  },

  rename: async (projectId, name) => {
    const updated = await apiClient.updateProject(projectId, { name })
    const projects = get().projects.map((p) => (p.id === projectId ? updated : p))
    set({
      projects,
      activeProject: findActive(projects, get().activeProjectId),
    })
  },

  togglePinned: async (projectId, pinned) => {
    const updated = await apiClient.updateProject(projectId, { pinned })
    const projects = get().projects.map((p) => (p.id === projectId ? updated : p))
    set({
      projects,
      activeProject: findActive(projects, get().activeProjectId),
    })
  },

  remove: async (projectId) => {
    await apiClient.deleteProject(projectId)
    const projects = get().projects.filter((p) => p.id !== projectId)
    const activeId = get().activeProjectId
    const nextActiveId = activeId === projectId ? null : activeId
    if (activeId === projectId) writeActiveToStorage(null)
    set({
      projects,
      activeProjectId: nextActiveId,
      activeProject: findActive(projects, nextActiveId),
    })
  },

  removeRemote: async (projectId) => {
    await remoteOs.stopRuntime(projectId).catch(() => undefined)
    const remoteProjects = get().remoteProjects.filter((project) => project.id !== projectId)
    await saveRemoteProjects(remoteProjects)
    const projects = get().projects.filter((project) => project.id !== projectId)
    const activeId = get().activeProjectId
    const nextActiveId = activeId === projectId ? null : activeId
    if (activeId === projectId) {
      writeActiveToStorage(null)
      apiClient.useLocalRuntime()
    }
    const remoteRuntimes = { ...get().remoteRuntimes }
    delete remoteRuntimes[projectId]
    set({ remoteProjects, projects, remoteRuntimes, activeProjectId: nextActiveId, activeProject: findActive(projects, nextActiveId) })
  },
}))

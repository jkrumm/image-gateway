/**
 * `~/Pictures/ImageGen/.imagegen/` IO — projects, style guides, and the persisted Create draft
 * (docs/concept.md §6). Mirrors `library.ts`/`derived.ts`'s fs idiom (same `BaseDirectory.Picture`
 * root, same mkdir-then-writeFile shape), but goes through a small `StudioFs` port instead of
 * calling `@tauri-apps/plugin-fs` inline (code-style.md: "ports and adapters... inject
 * dependencies rather than stacking test infrastructure"). Reading/writing `.imagegen/*.json`
 * outside a Tauri webview is otherwise untestable — `library.ts`/`derived.ts` have no test files
 * for exactly this reason (see the repo AGENTS.md's validation-surface note); this port is what
 * lets `studio-store.test.ts` pin the "missing file reads as absent, not throw" contract without
 * a Tauri runtime. Production code imports `studioStore`, the singleton bound to the real Tauri
 * adapter; tests build their own store via `createStudioStore()` with an in-memory fake.
 *
 * `searches/` is reserved (docs/concept.md §6: "not built until roles+search demonstrably fall
 * short") — no IO for it here.
 */
import {
  projectSchema,
  styleGuideSchema,
  type Project,
  type StyleGuide,
} from '@image-gateway/shared'
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { warn as logWarn } from '@tauri-apps/plugin-log'

/** `.imagegen/` root, relative to the OS Pictures directory — mirrors `library.ts`'s `ROOT`. */
const ROOT = 'ImageGen/.imagegen'
const PROJECTS_DIR = `${ROOT}/projects`
const STYLES_DIR = `${ROOT}/styles`
const CREATE_DRAFT_PATH = `${ROOT}/drafts/create.json`
const SETTINGS_PATH = `${ROOT}/settings.json`

type DirEntry = { name: string; isDirectory: boolean; isFile: boolean }

/** The filesystem primitives `studio-store.ts` needs — small and specific to this module's
 * shape, not a general Tauri-fs wrapper. */
export type StudioFs = {
  exists: (path: string) => Promise<boolean>
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, contents: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  readDir: (path: string) => Promise<DirEntry[]>
  warn: (message: string) => void
}

const tauriFs: StudioFs = {
  exists: (path) => exists(path, { baseDir: BaseDirectory.Picture }),
  readTextFile: (path) => readTextFile(path, { baseDir: BaseDirectory.Picture }),
  writeTextFile: (path, contents) =>
    writeTextFile(path, contents, { baseDir: BaseDirectory.Picture }),
  mkdir: (path) => mkdir(path, { baseDir: BaseDirectory.Picture, recursive: true }),
  readDir: (path) => readDir(path, { baseDir: BaseDirectory.Picture }),
  warn: (message) => void logWarn(message),
}

function dirOf(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash === -1 ? path : path.slice(0, lastSlash)
}

async function readJson(fs: StudioFs, path: string): Promise<unknown | undefined> {
  const fileExists = await fs.exists(path)
  if (!fileExists) return undefined
  const raw = await fs.readTextFile(path)
  return JSON.parse(raw)
}

async function writeJson(fs: StudioFs, path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirOf(path))
  await fs.writeTextFile(path, JSON.stringify(value, null, 2))
}

/** Lists a directory's entries, reading a missing directory as empty rather than throwing. */
async function listDir(fs: StudioFs, dir: string): Promise<DirEntry[]> {
  const dirExists = await fs.exists(dir)
  if (!dirExists) return []
  return fs.readDir(dir)
}

export type StudioStore = {
  listProjects: () => Promise<Project[]>
  readProject: (slug: string) => Promise<Project | undefined>
  saveProject: (project: Project) => Promise<void>
  listStyleGuides: () => Promise<StyleGuide[]>
  readStyleGuide: (slug: string) => Promise<StyleGuide | undefined>
  saveStyleGuide: (guide: StyleGuide) => Promise<void>
  /** Opaque JSON blob — G4 owns the Create-draft shape (`shared`'s `createDraftSchema` is a
   * sketch, not this module's contract); callers validate what they get back themselves. */
  readCreateDraft: () => Promise<unknown | undefined>
  writeCreateDraft: (draft: unknown) => Promise<void>
  /** Gateway connection settings. Opaque here — `settings.ts` owns the shape and validates. */
  readSettings: () => Promise<unknown | undefined>
  writeSettings: (settings: unknown) => Promise<void>
}

export function createStudioStore(fs: StudioFs = tauriFs): StudioStore {
  async function readProject(slug: string): Promise<Project | undefined> {
    const raw = await readJson(fs, `${PROJECTS_DIR}/${slug}.json`)
    if (raw === undefined) return undefined
    return projectSchema.parse(raw)
  }

  async function listProjects(): Promise<Project[]> {
    const files = await listDir(fs, PROJECTS_DIR)
    const projects: Project[] = []
    for (const file of files) {
      if (!file.isFile || !file.name.endsWith('.json')) continue
      const raw = await readJson(fs, `${PROJECTS_DIR}/${file.name}`)
      const parsed = projectSchema.safeParse(raw)
      if (!parsed.success) {
        fs.warn(`Skipping invalid project at ${PROJECTS_DIR}/${file.name}: ${parsed.error.message}`)
        continue
      }
      projects.push(parsed.data)
    }
    return projects
  }

  async function saveProject(project: Project): Promise<void> {
    const parsed = projectSchema.parse(project)
    await writeJson(fs, `${PROJECTS_DIR}/${parsed.slug}.json`, parsed)
  }

  function styleGuideDir(slug: string): string {
    return `${STYLES_DIR}/${slug}`
  }

  async function readStyleGuide(slug: string): Promise<StyleGuide | undefined> {
    const dir = styleGuideDir(slug)
    const raw = await readJson(fs, `${dir}/style.json`)
    if (raw === undefined) return undefined
    const parsed = styleGuideSchema.safeParse(raw)
    if (!parsed.success) {
      fs.warn(`Skipping invalid style guide at ${dir}/style.json: ${parsed.error.message}`)
      return undefined
    }
    return parsed.data
  }

  async function listStyleGuides(): Promise<StyleGuide[]> {
    const dirs = await listDir(fs, STYLES_DIR)
    const guides: StyleGuide[] = []
    for (const entry of dirs) {
      if (!entry.isDirectory) continue
      const guide = await readStyleGuide(entry.name)
      if (guide !== undefined) guides.push(guide)
    }
    return guides
  }

  /** Writes `style.json` and ensures `refs/`/`sources/` exist alongside it (populated later by
   * the distill flow / manual imports — no read/write logic for their contents here, per the
   * brief). */
  async function saveStyleGuide(guide: StyleGuide): Promise<void> {
    const parsed = styleGuideSchema.parse(guide)
    const dir = styleGuideDir(parsed.slug)
    await fs.mkdir(`${dir}/refs`)
    await fs.mkdir(`${dir}/sources`)
    await writeJson(fs, `${dir}/style.json`, parsed)
  }

  async function readCreateDraft(): Promise<unknown | undefined> {
    return readJson(fs, CREATE_DRAFT_PATH)
  }

  async function writeCreateDraft(draft: unknown): Promise<void> {
    await writeJson(fs, CREATE_DRAFT_PATH, draft)
  }

  async function readSettings(): Promise<unknown | undefined> {
    return readJson(fs, SETTINGS_PATH)
  }

  async function writeSettings(settings: unknown): Promise<void> {
    await writeJson(fs, SETTINGS_PATH, settings)
  }

  return {
    listProjects,
    readProject,
    saveProject,
    listStyleGuides,
    readStyleGuide,
    saveStyleGuide,
    readCreateDraft,
    writeCreateDraft,
    readSettings,
    writeSettings,
  }
}

/** The production store, bound to the real Tauri fs — what app code imports. */
export const studioStore = createStudioStore()

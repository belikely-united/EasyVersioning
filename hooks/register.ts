import type { EngineInterface, Register } from 'claude-code'

import { ACTIONS, CLASH_FIXER, HAIKU, RULES, engine, saveLabel } from './core'
import type { Deps, Run, Saved, Synced } from './core'

const TOOL = 'mcp__easyversioning__versions'
const CHECK_EVERY_MS = 5 * 60_000
const STARTUP_FETCH_MS = 15_000

type Project = { key: string; path: string }

const projectsKey = 'projects'

const session = {
  memo: {} as Deps['memo'],
  isBusy: false,
  hasRules: false,
  lastPrompt: '',
  lastWords: null as string | null,
  project: null as Project | null,
  isToolReady: false,
  timerStarted: false,
  line: Promise.resolve<unknown>(undefined),
}

/** Git work runs one job at a time, so a timer never collides with a save. */
const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
  const done = session.line.then(job, job)
  session.line = done.catch(() => undefined)
  return done
}

const depsFor = ($: EngineInterface): Deps => {
  const run: Run = async (argv, options = {}) => {
    const { input, ...rest } = options
    try {
      const r = await $.process.run(argv, { ...rest, stdin: input })
      return { code: r.exitCode, out: r.stdout, err: r.stderr }
    } catch (error) {
      return { code: 127, out: '', err: String(error) }
    }
  }
  const ask = async (prompt: string) => {
    try {
      const reply = await $.model.complete({
        model: HAIKU,
        prompt,
        maxTokens: 300,
        effort: 'low',
        timeoutMs: 20_000,
      })
      return reply.isAnswered ? reply.text : null
    } catch {
      return null
    }
  }
  return { run, ask, memo: session.memo }
}

const here = async ($: EngineInterface) => engine(depsFor($), await $.session.cwd())

/** The same project on every worktree: its GitHub address. */
const findProject = async ($: EngineInterface): Promise<Project | null> => {
  const { run } = depsFor($)
  const path = await $.session.cwd()
  const url = await run(['git', 'remote', 'get-url', 'origin'], { cwd: path })
  if (url.code !== 0 || url.out.trim() === '') return null
  // A store key has a length limit and a project's address does not.
  const address = new TextEncoder().encode(url.out.trim().replace(/\.git$/, ''))
  const digest = await crypto.subtle.digest('SHA-256', address)
  const hex = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
  return { key: `on:${hex}`, path }
}

const isOn = async ($: EngineInterface, p: Project) =>
  (await $.store.get(p.key)) === true

const showStatus = async ($: EngineInterface) => {
  $.ui.status(await (await here($)).headline())
}

const tellSaved = ($: EngineInterface, saved: Saved) => {
  if (saved.started !== undefined) {
    $.ui.toast(`Started the experiment "${saved.started}". It won't affect anyone.`)
  }
  if (saved.heldBack?.length) {
    $.ui.toast(`Left out ${saved.heldBack.join(', ')}: passwords or very large files stay on this computer.`, {
      timeoutMs: 10_000,
    })
  }
  if (saved.say !== undefined) $.ui.toast(saved.say, { timeoutMs: 10_000 })
  if (saved.isOnline === false) {
    $.ui.toast('Saved on this computer. It will go online when it can.')
  }
}

/** Words the person sees, and the same for the model when it should react. */
const syncWords = (synced: Synced) => {
  if (synced.isOffline) return 'Offline, so no updates from the team yet.'
  if (synced.clash !== undefined) {
    return `You and ${synced.clash.with} changed the same thing. It needs fixing before you can share.`
  }
  if (synced.blocked !== undefined) return synced.blocked
  return synced.got.length > 0 ? `${synced.got.join('. ')}.` : null
}

const tell = async ($: EngineInterface, words: string, model?: string) => {
  await $.session.append({
    message: { type: 'system', content: [{ type: 'text', text: `EasyVersioning: ${words}` }] },
  }).catch(() => undefined)
  if (model !== undefined) {
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: model }] },
    }).catch(() => undefined)
  }
}

const reminders = async ($: EngineInterface, current: Project) => {
  const found: string[] = []
  const add = (left: Awaited<ReturnType<ReturnType<typeof engine>['leftBehind']>>) => {
    if (left.unsaved > 0) found.push(`${left.unsaved} changed files not saved`)
    if (left.unsent > 0) found.push(`${left.unsent} saves not sent to GitHub`)
    if (left.stashes > 0) found.push(`${left.stashes} tucked-away changes`)
    if (left.busyCopies.length > 0) found.push(`unsaved work in ${left.busyCopies.length} other copies`)
    if (left.unfinished.length > 0) found.push(`unfinished: ${left.unfinished.join(', ')}`)
    if (left.otherComputer.length > 0) found.push(`on another computer: ${left.otherComputer.join(', ')}`)
  }
  add(await (await here($)).leftBehind())
  const others = ((await $.store.get(projectsKey)) ?? []) as Project[]
  for (const other of others) {
    if (other.key === current.key) continue
    const left = await engine(depsFor($), other.path).leftBehind().catch(() => null)
    if (left !== null && left.unsaved + left.unsent > 0) {
      found.push(`${other.path.split('/').pop()} has work not saved`)
    }
  }
  return found
}

const syncAndReport = async ($: EngineInterface, timeoutMs?: number) => {
  const kit = await here($)
  const saved = await kit.save('Saved work', 'Unfinished work')
  tellSaved($, saved)
  const synced = await kit.sync(timeoutMs)
  const words = syncWords(synced)
  const isNews = words !== session.lastWords
  session.lastWords = words
  if (words !== null && isNews) {
    await tell(
      $,
      words,
      synced.clash === undefined
        ? undefined
        : `[EasyVersioning] ${words} When the person is ready, start the clash steps.`,
    )
  }
  await showStatus($)
}

const startTimer = ($: EngineInterface) => {
  if (session.timerStarted) return
  session.timerStarted = true
  $.clock.every(CHECK_EVERY_MS, () => {
    if (!session.isBusy) void inTurn(() => syncAndReport($)).catch(() => undefined)
  })
}

const readyTools = async ($: EngineInterface, isFromStart: boolean) => {
  if (session.isToolReady) return
  session.isToolReady = true
  await $.tool.register({
    name: 'versions',
    isDeferred: !isFromStart,
    description:
      'Saves, syncs and shares work for non-technical people. Use this instead of Git commands. The rules are in the EasyVersioning section.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        name: { type: 'string', description: 'Experiment or team name' },
        team: { type: 'string', description: 'Team name, or "none"' },
        people: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub usernames for start_team',
        },
        version: { type: 'string', description: 'From share_preview, or earlier_versions' },
        title: { type: 'string', description: 'From share_preview' },
        summary: { type: 'string', description: 'From share_preview' },
        value: { type: 'boolean', description: 'For remember_goes_live' },
      },
      required: ['action'],
    },
  })
  await $.agent.register({
    name: 'clash-fixer',
    description: 'Fixes clashes between two people’s work in the files clash_start names.',
    prompt: CLASH_FIXER,
    tools: ['Read', 'Edit'],
    model: HAIKU,
    omitClaudeMd: true,
  })
}

const turnOn = async ($: EngineInterface, p: Project) => {
  await $.store.set(p.key, true)
  const known = ((await $.store.get(projectsKey)) ?? []) as Project[]
  const others = known.filter(one => one.key !== p.key)
  await $.store.set(projectsKey, [...others, p])
  startTimer($)
}

const turnOff = async ($: EngineInterface, p: Project) => {
  await $.store.delete(p.key)
  const known = ((await $.store.get(projectsKey)) ?? []) as Project[]
  await $.store.set(projectsKey, known.filter(one => one.key !== p.key))
  $.ui.status(undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'easyversioning',
      description: 'Turn EasyVersioning on or off for this project, or see where things stand',
      argumentHint: 'on | off | status',
    })
    session.project = await findProject($)
    if (session.project === null) return started
    if (!(await isOn($, session.project))) {
      $.ui.status('EasyVersioning is off here. Type /easyversioning on')
      return started
    }
    const current = session.project
    session.hasRules = true
    await readyTools($, true)
    startTimer($)
    await inTurn(() => syncAndReport($, STARTUP_FETCH_MS)).catch(() => undefined)
    const found = await inTurn(() => reminders($, current)).catch(() => [])
    if (found.length > 0) {
      await tell(
        $,
        `Left behind: ${found.join('; ')}.`,
        `[EasyVersioning] At the start of your next reply, remind the person in one plain line about: ${found.join('; ')}.`,
      )
    }
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!session.hasRules) return composed
    return {
      sections: [
        ...composed.sections,
        { id: 'easyversioning:rules', text: RULES, scope: 'session' as const },
      ],
    }
  })

  on('prompt.submit', ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) session.lastPrompt = e.text
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) session.isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const finished = await next(e)
    if (e.agentId !== undefined) return finished
    session.isBusy = false
    if (session.project === null || !(await isOn($, session.project))) return finished
    await inTurn(async () => {
      const kit = await here($)
      tellSaved($, await kit.save(saveLabel(session.lastPrompt), session.lastPrompt))
      await showStatus($)
    }).catch(() => undefined)
    return finished
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Parameters<ReturnType<typeof engine>['act']>[0]
    if (session.project === null || !(await isOn($, session.project))) {
      return { result: 'EasyVersioning is off for this project. The person can type /easyversioning on.' }
    }
    const answer = await inTurn(async () => (await here($)).act(input))
    await inTurn(() => showStatus($)).catch(() => undefined)
    return { result: answer }
  })

  on('command.run', { command: 'easyversioning' }, async ($, e) => {
    session.project ??= await findProject($)
    if (session.project === null) {
      return { text: 'This folder is not connected to GitHub yet, so EasyVersioning cannot run here.' }
    }
    const word = e.args.trim().toLowerCase()
    const current = session.project
    if (word === 'off') {
      await turnOff($, current)
      return { text: 'EasyVersioning is off for this project. Nothing was changed.' }
    }
    if (word === 'on') {
      await turnOn($, current)
      await readyTools($, false)
      const wasReady = session.hasRules
      session.hasRules = true
      await inTurn(() => syncAndReport($)).catch(() => undefined)
      return {
        text: 'EasyVersioning is on for this project. Work now saves by itself after each task.',
        context: wasReady ? undefined : [RULES],
      }
    }
    if (!(await isOn($, current))) {
      return { text: 'EasyVersioning is off for this project. Type /easyversioning on to start.' }
    }
    const headline = await inTurn(async () => (await here($)).headline())
    const found = await inTurn(() => reminders($, current))
    return {
      text: [headline, ...found.map(item => `Left behind: ${item}`)].join('\n'),
    }
  })
}

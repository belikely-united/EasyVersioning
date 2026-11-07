// Runs EasyVersioning against real Git repositories in a temp folder.
// GitHub is played by a local bare repository and a small stand-in for `gh`.
// Run with: bun tests/real-git.check.ts

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { engine, saveLabel, slug, displayName, SETTINGS_FILE } from '../hooks/core'
import type { Deps, Result, Run, RunOptions } from '../hooks/core'

const root = mkdtempSync(join(tmpdir(), 'easyversioning-'))
const originPath = join(root, 'origin.git')
const landerPath = join(root, 'github-side')

const sh: Run = (argv, options: RunOptions = {}) =>
  new Promise<Result>(resolve => {
    const [bin = '', ...args] = argv
    const child = execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 1 << 24,
        timeout: options.timeoutMs,
      },
      (error, out, err) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 127
        resolve({ code, out, err })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })

const must = async (cwd: string, ...args: string[]) => {
  const r = await sh(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`)
  return r.out.trim()
}

type GitHub = { review: boolean; rejectAuto: boolean; prs: Map<string, { base: string; head: string; state: string }> }
const github: GitHub = { review: false, rejectAuto: false, prs: new Map() }

/** Plays GitHub: a share request really lands on the bare repository. */
async function fakeGh(login: string, args: string[]): Promise<Result> {
  const ok = (out = ''): Result => ({ code: 0, out, err: '' })
  if (args[0] === 'api') return ok(`${login}\n`)
  const flag = (name: string) => args[args.indexOf(name) + 1] ?? ''
  if (args[0] === 'pr' && args[1] === 'list') {
    const found = [...github.prs.entries()].find(
      ([, pr]) => pr.head === flag('--head') && pr.state === 'OPEN',
    )
    return ok(`${found?.[0] ?? ''}\n`)
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    const url = `https://github.test/pr/${github.prs.size + 1}`
    github.prs.set(url, { base: flag('--base'), head: flag('--head'), state: 'OPEN' })
    return ok(`${url}\n`)
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    return ok(`${github.prs.get(args[2] ?? '')?.state ?? ''}\n`)
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const pr = github.prs.get(args[2] ?? '')
    if (pr === undefined) return { code: 1, out: '', err: 'no pr' }
    if (args.includes('--auto')) return github.rejectAuto ? { code: 1, out: '', err: 'no' } : ok()
    if (github.rejectAuto) return { code: 1, out: '', err: 'blocked' }
    await landPr(pr, args.includes('--squash'), flag('--subject'), flag('--body'))
    return ok()
  }
  return { code: 1, out: '', err: `fake gh: ${args.join(' ')}` }
}

async function landPr(
  pr: { base: string; head: string; state: string },
  isSquash: boolean,
  subject: string,
  body: string,
) {
  await must(landerPath, 'fetch', '--prune', 'origin')
  await must(landerPath, 'switch', '-q', '--force-create', 'landing', `origin/${pr.base}`)
  if (isSquash) {
    await must(landerPath, 'merge', '-q', '--squash', `origin/${pr.head}`)
    await must(landerPath, 'commit', '-q', '-m', subject, '-m', body)
  } else {
    await must(landerPath, 'merge', '-q', '--no-ff', '-m', subject, '-m', body, `origin/${pr.head}`)
  }
  await must(landerPath, 'push', '-q', 'origin', `HEAD:${pr.base}`)
  pr.state = 'MERGED'
}

async function person(name: string, login = name.toLowerCase()) {
  const folder = join(root, name)
  await must(root, 'clone', '-q', originPath, folder)
  await must(folder, 'config', 'user.name', name)
  await must(folder, 'config', 'user.email', `${login}@example.test`)
  const deps: Deps = {
    memo: {},
    ask: async prompt => {
      if (prompt.startsWith('Name this')) return prompt.split('Work: ')[1] ?? null
      return 'Plain title\n- Something got better'
    },
    run: (argv, options) => {
      const bin = argv[0] ?? ''
      return bin === 'gh' ? fakeGh(login, argv.slice(1)) : sh(argv, options)
    },
  }
  return {
    folder,
    kit: engine(deps, folder),
    git: (...args: string[]) => must(folder, ...args),
    write: (file: string, text: string) => writeFileSync(join(folder, file), text),
    read: (file: string) => readFileSync(join(folder, file), 'utf8'),
    has: (file: string) => existsSync(join(folder, file)),
  }
}

let failures = 0
function check(what: string, isTrue: boolean, detail: unknown = '') {
  if (!isTrue) failures += 1
  console.log(`${isTrue ? '  ok ' : 'FAIL '} ${what}${isTrue ? '' : ` -> ${JSON.stringify(detail)}`}`)
}
const originLog = (branch: string) =>
  must(landerPath, 'fetch', '--prune', 'origin').then(() =>
    must(landerPath, 'log', '--format=%s', `origin/${branch}`),
  )
const originFiles = (branch: string) =>
  must(landerPath, 'fetch', '--prune', 'origin').then(() =>
    must(landerPath, 'ls-tree', '-r', '--name-only', `origin/${branch}`),
  )
const preview = async (kit: { act: (i: { action: string }) => Promise<string> }) =>
  JSON.parse(await kit.act({ action: 'share_preview' })) as Record<string, string | boolean>
const shareNow = async (kit: { act: (i: object) => Promise<string> }) => {
  const p = (await preview(kit as never)) as Record<string, string>
  return kit.act({ action: 'share', version: p.version, title: p.title, summary: p.summary })
}

async function main() {
  await must(root, 'init', '-q', '--bare', '-b', 'main', originPath)
  const seedPath = join(root, 'seed')
  await must(root, 'clone', '-q', originPath, seedPath)
  await must(seedPath, 'switch', '-q', '-c', 'main')
  await must(seedPath, 'config', 'user.name', 'Seed')
  await must(seedPath, 'config', 'user.email', 'seed@example.test')
  writeFileSync(join(seedPath, 'page.txt'), 'title: old\nbody: old\nfooter: old\n')
  await must(seedPath, 'add', '-A')
  await must(seedPath, 'commit', '-q', '-m', 'first')
  await must(seedPath, 'push', '-q', 'origin', 'main')
  await must(root, 'clone', '-q', originPath, landerPath)
  await must(landerPath, 'config', 'user.name', 'GitHub')
  await must(landerPath, 'config', 'user.email', 'github@example.test')

  const alex = await person('Alex')
  const sam = await person('Sam')
  const maya = await person('Maya')

  console.log('\nSaving')
  alex.write('page.txt', 'title: new\nbody: old\nfooter: old\n')
  const fakeKey = `sk-${'a'.repeat(30)}`
  alex.write('.env', 'PASSWORD=hunter2\n')
  alex.write('.env.example', 'PASSWORD=\n')
  alex.write('notes.txt', `key ${fakeKey}\n`)
  alex.write('big.bin', '')
  truncateSync(join(alex.folder, 'big.bin'), 60_000_000)
  const saved = await alex.kit.save('Change the title', 'Change the title')
  check('work on the shared version moves to an experiment', saved.started === 'Change the title', saved)
  check('the shared version stays untouched', (await originLog('main')) === 'first')
  check('the save reaches GitHub', saved.isOnline === true, saved)
  check('passwords, secrets and huge files are held back',
    ['.env', 'notes.txt', 'big.bin'].every(f => saved.heldBack?.includes(f)), saved.heldBack)
  const branch = await alex.git('branch', '--show-current')
  check('the example env file is still saved', (await originFiles(branch)).includes('.env.example'))
  check('held-back files are not on GitHub', !/\.env\n|notes|big/.test(`${await originFiles(branch)}\n`))
  rmSync(join(alex.folder, '.env'))
  rmSync(join(alex.folder, 'notes.txt'))
  rmSync(join(alex.folder, 'big.bin'))

  console.log('\nGetting the latest')
  sam.write('other.txt', 'from sam\n')
  await sam.kit.save('Add other page')
  await shareNow(sam.kit)
  check('sharing lands on the shared version', (await originFiles('main')).includes('other.txt'))
  check('after sharing the person is back on the shared version',
    (await sam.git('branch', '--show-current')) === 'main')
  check('a shared experiment is archived, not lost',
    (await must(landerPath, 'branch', '-r')).includes('origin/shared/sam/add-other-page'))
  const synced = await alex.kit.sync()
  check('updates arrive in an open experiment', alex.has('other.txt') && synced.got.length > 0, synced)
  check('the merged work stays on GitHub too',
    (await originFiles(await alex.git('branch', '--show-current'))).includes('other.txt'))

  console.log('\nClashes')
  maya.write('page.txt', 'title: maya\nbody: old\nfooter: old\n')
  await maya.kit.save('Maya title')
  const mayaPreview = await preview(maya.kit)
  await maya.kit.act({ action: 'share', version: mayaPreview.version, title: 't', summary: 's' })
  const clash = await alex.kit.sync()
  check('a clash is found', clash.clash?.files.includes('page.txt') === true, clash)
  check('finding a clash touches nothing',
    alex.read('page.txt').startsWith('title: new') && (await alex.git('status', '--porcelain')) === '')
  check('the status says it needs attention', !(await alex.kit.headline()).startsWith('✓'))
  await alex.kit.act({ action: 'clash_start' })
  check('the clash is opened for fixing', alex.read('page.txt').includes('<<<<<<<'))
  check('nothing saves over an open clash', (await alex.kit.save('x')).state === 'clash')
  check('an unfixed clash cannot finish',
    (await alex.kit.act({ action: 'clash_finish' })).includes('not fixed'))
  await alex.kit.act({ action: 'clash_cancel' })
  check('backing out restores the work', alex.read('page.txt').startsWith('title: new'))
  await alex.kit.act({ action: 'clash_start' })
  alex.write('page.txt', 'title: both\nbody: old\nfooter: old\n')
  const fixed = await alex.kit.act({ action: 'clash_finish' })
  check('a fixed clash is saved', fixed.includes('fixed') && alex.read('page.txt').startsWith('title: both'), fixed)

  console.log('\nShare guards')
  const seen = await preview(alex.kit)
  check('the preview has a plain summary', seen.title === 'Plain title' && seen.sharesWith === 'everyone', seen)
  alex.write('late.txt', 'late\n')
  await alex.kit.save('Late change')
  check('work changed after the preview is not shared',
    (await alex.kit.act({ action: 'share', version: seen.version as string })).includes('changed after'))
  check('nothing landed', !(await originFiles('main')).includes('late.txt'))

  console.log('\nUndo')
  const shareResult = await shareNow(alex.kit)
  check('the share succeeds', shareResult.startsWith('Done'), shareResult)
  check('it reached everyone', (await originFiles('main')).includes('late.txt'))
  const undone = await alex.kit.act({ action: 'undo_share' })
  check('undo removes it for everyone', !(await originFiles('main')).includes('late.txt'), undone)
  check('the work is back as an experiment',
    undone.includes('back as an experiment') && (await alex.git('branch', '--show-current')).startsWith('experiment/alex/'), undone)
  check('the experiment still has the work', alex.has('late.txt'))

  console.log('\nGoing back')
  const before = (await alex.kit.act({ action: 'earlier_versions' })).split('\n')[0]?.split(' | ')[0] ?? ''
  alex.write('late.txt', 'changed\n')
  await alex.kit.save('Change late')
  const back = await alex.kit.act({ action: 'go_back', version: before })
  check('going back restores the earlier version', alex.read('late.txt') === 'late\n', back)
  check('going back keeps history', (await alex.git('log', '--format=%s')).includes('Change late'))
  check('a bad version is refused', (await alex.kit.act({ action: 'go_back', version: '--hard' })).includes('Pick'))

  console.log('\nTeams')
  await alex.kit.act({ action: 'set_aside' })
  check('set aside returns to the shared version', (await alex.git('branch', '--show-current')) === 'main')
  const team = await sam.kit.act({ action: 'start_team', name: 'Checkout', people: ['sam', 'alex'] })
  check('a team is created', team.includes('ready'), team)
  check('the settings file exists only now', (await originFiles('main')).includes(SETTINGS_FILE))
  check('the team version exists', (await must(landerPath, 'branch', '-r')).includes('origin/team/checkout'))
  const settings = JSON.parse(await must(landerPath, 'show', `origin/main:${SETTINGS_FILE}`))
  check('the file holds only what differs from defaults',
    Object.keys(settings).join() === 'teams', settings)

  await sam.kit.sync()
  await sam.kit.act({ action: 'start_experiment', name: 'Team idea' })
  check('a team member gets a team experiment',
    (await sam.git('branch', '--show-current')).endsWith('@checkout'))
  sam.write('team.txt', 'team work\n')
  await sam.kit.save('Team work')
  const teamView = await preview(sam.kit)
  check('sharing goes to the team first', String(teamView.sharesWith).includes('Checkout'), teamView)
  await sam.kit.act({ action: 'share', version: teamView.version, title: 'Team idea', summary: 'x' })
  check('the team gets it', (await originFiles('team/checkout')).includes('team.txt'))
  check('the company does not', !(await originFiles('main')).includes('team.txt'))

  maya.write('solo.txt', 'solo\n')
  await maya.kit.sync()
  await maya.kit.save('Solo work')
  const soloView = await preview(maya.kit)
  check('someone with no team shares straight with everyone', soloView.sharesWith === 'everyone', soloView)
  await maya.kit.act({ action: 'share', version: soloView.version, title: 'Solo', summary: 'x' })
  check('their work reaches everyone', (await originFiles('main')).includes('solo.txt'))

  await sam.kit.act({ action: 'start_experiment', name: 'Second idea' })
  await sam.kit.sync()
  check('company updates reach the team version without anyone asking',
    (await originFiles('team/checkout')).includes('solo.txt'))
  check('and reach the experiment', sam.has('solo.txt'))
  await sam.kit.act({ action: 'set_aside' })
  check('set aside returns to the team version',
    (await sam.git('branch', '--show-current')) === 'team/checkout')
  const teamPackage = await preview(sam.kit)
  check('a team version shares with everyone', teamPackage.sharesWith === 'everyone', teamPackage)
  const packaged = await sam.kit.act({ action: 'share', version: teamPackage.version, title: 'Checkout', summary: 'x' })
  check('the team package lands', (await originFiles('main')).includes('team.txt'), packaged)
  check('the team version stays for more work',
    (await must(landerPath, 'branch', '-r')).includes('origin/team/checkout'))

  console.log('\nLeft behind and wrong places')
  await maya.kit.sync()
  await maya.git('commit', '-q', '--allow-empty', '-m', 'Forgot to send this')
  const rescued = await maya.kit.sync()
  check('commits on the shared version move to an experiment',
    (await maya.git('branch', '--show-current')).startsWith('experiment/maya/'), rescued)
  check('the shared version here is clean again',
    (await maya.git('rev-parse', 'main')) === (await maya.git('rev-parse', 'origin/main')))
  check('the rescued work reached GitHub',
    (await originLog(await maya.git('branch', '--show-current'))).includes('Forgot to send this'))
  await maya.kit.act({ action: 'set_aside' })
  maya.write('stash.txt', 'tucked\n')
  await maya.git('add', '-A')
  await maya.git('stash')
  maya.write('open.txt', 'open\n')
  const left = await maya.kit.leftBehind()
  check('unsaved work is noticed', left.unsaved === 1, left)
  check('tucked-away work is noticed', left.stashes === 1, left)
  check('unfinished experiments are noticed', left.unfinished.length === 1, left)
  await maya.git('branch', '-q', '-D', (await maya.git('branch', '--format=%(refname:short)')).split('\n').find(b => b.startsWith('experiment/')) ?? '')
  check('work on another computer is noticed',
    (await maya.kit.leftBehind()).otherComputer.length === 1)
  await maya.kit.save('Open work')
  await maya.kit.sync()
  const headline = await maya.kit.headline()
  check('the status line says saved, not shared', headline.startsWith('● Saved, not shared'), headline)

  console.log('\nTwo computers')
  const laptop = await person('Laptop', 'maya')
  const mayaBranch = await maya.git('branch', '--show-current')
  await laptop.git('switch', '-q', mayaBranch)
  laptop.write('laptop.txt', 'laptop\n')
  await laptop.kit.save('From laptop')
  maya.write('studio.txt', 'studio\n')
  const offSync = await maya.kit.save('From studio')
  await maya.kit.sync()
  check('both computers end up with both changes',
    maya.has('laptop.txt') && maya.has('studio.txt'), offSync)
  check('the merged work reached GitHub', (await originFiles(mayaBranch)).includes('laptop.txt'))

  console.log('\nFinished branches')
  await laptop.git('switch', '-q', 'main')
  await laptop.git('pull', '-q')
  await laptop.git('switch', '-q', '-c', 'old-work')
  await laptop.git('push', '-q', '-u', 'origin', 'old-work')
  laptop.write('fresh.txt', 'fresh\n')
  const moved = await laptop.kit.save('Fresh work')
  check('work on an already merged branch moves to a new experiment', moved.started === 'Fresh work', moved)

  console.log('\nThings never saved')
  laptop.write('keep.txt', 'keep\n')
  await sh(['mkdir', '-p', join(laptop.folder, 'node_modules/pkg')])
  laptop.write('node_modules/pkg/index.js', 'x\n')
  await laptop.kit.save('With tools folder')
  const savedFiles = await originFiles(await laptop.git('branch', '--show-current'))
  check('rebuildable tool folders are skipped', savedFiles.includes('keep.txt') && !savedFiles.includes('node_modules'), savedFiles)

  console.log('\nTeam and company clash')
  await sam.git('switch', '-q', 'main')
  await sam.kit.sync()
  await sam.kit.act({ action: 'start_experiment', name: 'Team footer', team: 'Checkout' })
  sam.write('page.txt', 'title: both\nbody: old\nfooter: team\n')
  await sam.kit.save('Team footer')
  const teamFooter = await preview(sam.kit)
  await sam.kit.act({ action: 'share', version: teamFooter.version, title: 'Team footer', summary: 'x' })
  await must(seedPath, 'pull', '-q', 'origin', 'main')
  const seedPage = readFileSync(join(seedPath, 'page.txt'), 'utf8').replace(/footer: .*/, 'footer: company')
  writeFileSync(join(seedPath, 'page.txt'), seedPage)
  await must(seedPath, 'add', '-A')
  await must(seedPath, 'commit', '-q', '-m', 'company footer')
  await must(seedPath, 'push', '-q', 'origin', 'main')
  const teamBefore = await originLog('team/checkout')
  await sam.kit.act({ action: 'start_experiment', name: 'Next team idea', team: 'Checkout' })
  const teamClash = await sam.kit.sync()
  check('a team clash with the company is flagged', teamClash.clash?.with === 'everyone', teamClash)
  check('the team version is left as it was', (await originLog('team/checkout')) === teamBefore)
  await sam.kit.act({ action: 'clash_start' })
  sam.write('page.txt', 'title: both\nbody: old\nfooter: agreed\n')
  check('fixing it in the experiment works',
    (await sam.kit.act({ action: 'clash_finish' })).includes('fixed'))

  console.log('\nProject checks')
  await must(seedPath, 'pull', '-q', 'origin', 'main')
  writeFileSync(join(seedPath, SETTINGS_FILE), JSON.stringify({ check: 'test -f must-exist.txt' }))
  await must(seedPath, 'add', '-A')
  await must(seedPath, 'commit', '-q', '-m', 'add a check')
  await must(seedPath, 'push', '-q', 'origin', 'main')
  const checked = await person('Omar')
  checked.write('work.txt', 'x\n')
  await checked.kit.save('Failing work')
  const failing = await preview(checked.kit)
  check('a failing check stops sharing', failing.canShare === false && failing.checkRan === true, failing)
  checked.write('must-exist.txt', 'x\n')
  await checked.kit.save('Passing work')
  const passing = await preview(checked.kit)
  check('a passing check allows sharing', passing.canShare === true, passing)

  console.log('\nApproval and offline')
  await must(landerPath, 'fetch', 'origin')
  await must(seedPath, 'pull', '-q', 'origin', 'main')
  writeFileSync(join(seedPath, SETTINGS_FILE), JSON.stringify({ companyShare: 'review' }))
  await must(seedPath, 'add', '-A')
  await must(seedPath, 'commit', '-q', '-m', 'settings')
  await must(seedPath, 'push', '-q', 'origin', 'main')
  const newcomer = await person('Nia')
  newcomer.write('needs-ok.txt', 'x\n')
  await newcomer.kit.save('Needs approval')
  const askView = await preview(newcomer.kit)
  check('the preview says approval is needed', askView.needsApproval === true, askView)
  const waiting = await newcomer.kit.act({ action: 'share', version: askView.version, title: 'Needs OK', summary: 'x' })
  check('it waits for approval', waiting.includes('waiting') && !(await originFiles('main')).includes('needs-ok.txt'), waiting)
  const open = [...github.prs.values()].find(pr => pr.state === 'OPEN')
  if (open !== undefined) await landPr(open, true, 'Needs OK', 'x')
  const settled = await newcomer.kit.sync()
  check('approval finishes the share by itself', settled.got.some(line => line.includes('now shared')), settled)
  check('the person lands back on the shared version',
    (await newcomer.git('branch', '--show-current')) === 'main')

  await sh(['mv', originPath, `${originPath}.gone`])
  newcomer.write('offline.txt', 'x\n')
  const offline = await newcomer.kit.save('Offline work')
  check('offline work still saves here', offline.state === 'saved' && offline.isOnline === false, offline)
  check('offline sync says so', (await newcomer.kit.sync()).isOffline === true)
  await sh(['mv', `${originPath}.gone`, originPath])
  await newcomer.kit.save('Back online')
  const onlineBranch = await newcomer.git('branch', '--show-current')
  check('it goes online later', (await originFiles(onlineBranch)).includes('offline.txt'))

  console.log('\nSmall rules')
  check('secrets stay out of save labels', saveLabel(`use ${fakeKey} now`) === 'Saved work')
  check('labels are one short line', saveLabel(`${'x'.repeat(100)}\nmore`).length === 72)
  check('names read plainly', displayName('experiment/alex/new-pricing@checkout') === 'New pricing')
  check('slugs are safe', slug('  Hello, World!! ') === 'hello-world')
  check('the test folder is real', statSync(root).isDirectory())
}

await main().catch(error => {
  failures += 1
  console.error('CRASH', error)
})
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

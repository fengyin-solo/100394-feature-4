import { listRows, saveRows } from '@/data/local-store'
import { emptyCrackClock } from '@/data/types'
import type {
  ActionResult,
  CrackClock,
  CrackExtraPlan,
  CrackObservation,
  EntryRow,
} from '@/data/types'

// 裂缝处置时钟领域规则：
// 1. 节点按「首次异常 → 最近观测 → 约谈修复 → 复核」排列，只能向前推进，已完成节点不能倒退或清空；
// 2. 操作员只能安排加测（计划），不能借加测回改任何已完成节点；
// 3. 宽度与变化速率矛盾时，以变化速率触发复核（速率 ≥ RATE_REVIEW 即必复核；
//    仅绝对宽度关注而速率平稳时只标记加速关注，不进入复核）；
// 4. 旧测点缺初始宽度时增量判据跳过，保留为空；
// 5. 确认稳定同一测点只生效一次；任何写入的系统时间早于上次观测一律拒绝；
// 6. 确认修复后向巡查排查页派发一次销号复查任务。

const KEY = 'crack'
const PATROL_KEY = 'patrol'
const PATROL_TYPE = '销号复查'

const RATE_REVIEW = 0.5 // mm/d：变化速率复核线
const WIDTH_REVIEW = 5 // mm：绝对/增量宽度关注线（只做加速关注，不触发复核）

export function listCracks(): EntryRow[] {
  return listRows(KEY)
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseTime(value: string): number {
  const t = Date.parse(value)
  return Number.isNaN(t) ? NaN : t
}

function asClock(row: EntryRow): CrackClock {
  // 老数据可能没挂时钟，惰性补一个空结构再落库。
  if (row.clock && typeof row.clock === 'object') {
    return { ...emptyCrackClock(), ...row.clock }
  }
  return emptyCrackClock()
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

// 统一的时间闸门：写入时间不得早于上次观测，也不接受无法解析的时间。
function assertAfterLastObservation(
  clock: CrackClock,
  at: string,
  label = '操作时间',
): ActionResult | null {
  const t = parseTime(at)
  if (Number.isNaN(t)) {
    return { ok: false, message: `${label}格式不正确` }
  }
  if (clock.lastObservedAt && t < parseTime(clock.lastObservedAt)) {
    return {
      ok: false,
      message: `${label}（${at.replace('T', ' ')}）早于上次观测（${clock.lastObservedAt.replace('T', ' ')}），已拒绝`,
    }
  }
  return null
}

function persist(rows: EntryRow[], index: number, row: EntryRow): void {
  const next = [...rows]
  next[index] = row
  saveRows(KEY, next)
}

function findCrack(id: number): { rows: EntryRow[]; index: number; row: EntryRow; clock: CrackClock } {
  const rows = listRows(KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    throw new Error(`没有找到编号为 ${id} 的裂缝测点`)
  }
  const row = rows[index]
  return { rows, index, row, clock: asClock(row) }
}

function widthFlags(row: EntryRow, clock: CrackClock, width: number, rate: number) {
  const initial = toNumber(row['初始宽度'])
  const absolute = width >= WIDTH_REVIEW
  // 缺初始宽度的旧测点：增量判据跳过，只看绝对宽度与速率。
  const incremental = initial === null ? false : width - initial >= WIDTH_REVIEW
  const rateHit = rate >= RATE_REVIEW
  const widthHit = absolute || incremental
  return { initial, absolute, incremental, rateHit, widthHit }
}

type ObserveInput = {
  id: number
  at: string
  widthInput: string
  rateInput: string
  operator: string
}

// 记录一次观测（含安排过的加测落测）：更新「最近观测」，按速率优先规则判断是否触发复核。
export function recordObservation(input: ObserveInput): ActionResult {
  let ctx
  try {
    ctx = findCrack(input.id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，不能再录入观测；如需继续跟踪请重新登记测点' }
  }
  const at = input.at || nowText()
  const blocked = assertAfterLastObservation(clock, at, '观测时间')
  if (blocked) {
    return blocked
  }
  const now = parseTime(at)
  if (now > Date.now()) {
    return { ok: false, message: '观测时间不能晚于当前系统时间' }
  }
  const rate = toNumber(input.rateInput)
  if (rate === null) {
    return { ok: false, message: '请填写本次变化速率（mm/d）' }
  }
  if (rate < 0) {
    return { ok: false, message: '变化速率不能为负值' }
  }
  const width = toNumber(input.widthInput)

  const observation: CrackObservation = {
    at,
    width,
    rate,
    operator: input.operator || String(row['监测人'] ?? ''),
  }

  let status = String(row.status)
  let firstAbnormalAt = clock.firstAbnormalAt
  let recheck = clock.recheck
  let recheckRequestedAt = clock.recheckRequestedAt
  let recheckTrigger = clock.recheckTrigger
  const notes: string[] = []

  if (rate >= RATE_REVIEW || (width !== null && width >= WIDTH_REVIEW && row.status !== '已废弃')) {
    if (!firstAbnormalAt) {
      firstAbnormalAt = at
      notes.push('已补登首次异常节点')
    }
  }

  const flags = width !== null
    ? widthFlags(row, clock, width, rate)
    : { rateHit: rate >= RATE_REVIEW, widthHit: false, initial: null, absolute: false, incremental: false }

  if (flags.rateHit) {
    status = '加速发展'
    if (recheck !== 'done') {
      if (recheck === 'none') {
        recheck = 'pending'
        recheckRequestedAt = at
        recheckTrigger = 'rate'
        notes.push('变化速率达到复核线，已自动触发复核')
      }
    } else {
      notes.push('复核已完成，速率再次超线，请人工重新研判')
    }
  } else if (flags.widthHit) {
    // 宽度与速率矛盾：宽度到线但速率平稳，只做加速关注，不触发复核。
    if (status === '正常') {
      status = '加速发展'
      notes.push('宽度达到关注值但速率平稳，按速率优先规则暂不复核，转加速关注')
    }
  }

  // 到期的加测计划随本次观测闭合（同一测点允许一次观测完成多张计划）。
  const extras: CrackExtraPlan[] = clock.extras.map((plan) => {
    if (plan.status === '已安排' && parseTime(plan.scheduledAt) <= now) {
      notes.push(`加测计划 ${plan.scheduledAt.replace('T', ' ')} 已按本次观测完成`)
      return { ...plan, status: '已完成' as const, completedAt: at }
    }
    return plan
  })

  const nextClock: CrackClock = {
    ...clock,
    firstAbnormalAt,
    lastObservedAt: at,
    recheck,
    recheckRequestedAt,
    recheckTrigger,
    extras,
    history: [...clock.history, observation].sort((a, b) => parseTime(a.at) - parseTime(b.at)),
  }

  const updated: EntryRow = {
    ...row,
    status,
    abnormal: status === '加速发展' || row.abnormal === true,
    pending: status !== '已修复' && status !== '已废弃',
    '当前宽度': width === null ? '' : width,
    '变化速率': rate,
    clock: nextClock,
  }
  persist(rows, index, updated)
  return {
    ok: true,
    message: notes.length
      ? `观测已记录：${notes.join('；')}`
      : '观测已记录，最近观测节点已推进',
  }
}

type ExtraInput = { id: number; scheduledAt: string; reason: string; operator: string }

// 安排加测：只能新增一张未来执行的计划，不触碰任何已完成节点。
export function scheduleExtra(input: ExtraInput): ActionResult {
  let ctx
  try {
    ctx = findCrack(input.id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，不需要再安排加测' }
  }
  if (!input.scheduledAt) {
    return { ok: false, message: '请选择计划加测时间' }
  }
  if (parseTime(input.scheduledAt) <= Date.now()) {
    return { ok: false, message: '加测只能安排在当前系统时间之后' }
  }
  if (clock.lastObservedAt && parseTime(input.scheduledAt) <= parseTime(clock.lastObservedAt)) {
    return { ok: false, message: '加测时间必须晚于上次观测，不能借加测倒退节点' }
  }
  const duplicated = clock.extras.some(
    (plan) => plan.status === '已安排' && plan.scheduledAt === input.scheduledAt,
  )
  if (duplicated) {
    return { ok: false, message: '该时间已有一张待执行的加测计划' }
  }
  const seq = clock.extras.reduce((max, plan) => Math.max(max, plan.id), 0) + 1
  const plan: CrackExtraPlan = {
    id: seq,
    scheduledAt: input.scheduledAt,
    reason: input.reason || '加密观测',
    status: '已安排',
    createdAt: nowText(),
  }
  const updated: EntryRow = {
    ...row,
    clock: { ...clock, extras: [...clock.extras, plan] },
  }
  persist(rows, index, updated)
  return { ok: true, message: `加测已安排：${input.scheduledAt.replace('T', ' ')}（${plan.reason}），由${input.operator || '值班员'}跟踪` }
}

// 标记加速（首次异常节点）。已存在首次异常即视为重复，不允许改时间。
export function markAcceleration(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，不能回退为加速发展' }
  }
  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (clock.firstAbnormalAt) {
    return { ok: false, message: `首次异常节点已存在（${clock.firstAbnormalAt.replace('T', ' ')}），不能倒退或重复登记` }
  }
  const updated: EntryRow = {
    ...row,
    status: '加速发展',
    abnormal: true,
    pending: true,
    clock: { ...clock, firstAbnormalAt: at },
  }
  persist(rows, index, updated)
  return { ok: true, message: `已标记加速，首次异常节点锁定为 ${at.replace('T', ' ')}（${operator}）` }
}

// 约谈修复节点：必须已有首次异常（约谈针对异常裂缝），节点一旦完成不能重开。
export function talkRepair(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，约谈节点不能回退' }
  }
  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (!clock.firstAbnormalAt) {
    return { ok: false, message: '请先记录首次异常（标记加速或录入超线观测），再约谈修复' }
  }
  if (clock.talkRepairAt) {
    return { ok: false, message: `约谈修复节点已完成（${clock.talkRepairAt.replace('T', ' ')}），不能倒退或重复登记` }
  }
  const updated: EntryRow = {
    ...row,
    status: '加速发展',
    abnormal: true,
    pending: true,
    clock: { ...clock, talkRepairAt: at },
  }
  persist(rows, index, updated)
  return { ok: true, message: `约谈修复节点已完成（${operator} ${at.replace('T', ' ')}），等待复核安排` }
}

// 人工发起复核：速率超线时观测会自动发起，这里提供约谈后按规程补提的入口。
export function requestRecheck(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，复核流程已结束' }
  }
  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (clock.recheck === 'done') {
    return { ok: false, message: '复核节点已完成，不能倒退或重复发起' }
  }
  if (clock.recheck === 'pending') {
    return { ok: false, message: `复核已在 ${clock.recheckRequestedAt?.replace('T', ' ')} 发起（来源：${clock.recheckTrigger === 'rate' ? '变化速率自动触发' : '人工'}），等待现场复核` }
  }
  const updated: EntryRow = {
    ...row,
    pending: true,
    clock: { ...clock, recheck: 'pending', recheckRequestedAt: at, recheckTrigger: 'manual' },
  }
  persist(rows, index, updated)
  return { ok: true, message: `复核任务已发起（${operator} ${at.replace('T', ' ')}）` }
}

// 完成复核：完成后的节点不能再回到待复核。
export function completeRecheck(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (clock.recheck === 'none') {
    return { ok: false, message: '尚未发起复核，不能直接完成复核节点' }
  }
  if (clock.recheck === 'done') {
    return { ok: false, message: `复核节点已于 ${clock.recheckCompletedAt?.replace('T', ' ')} 完成，不能倒退` }
  }
  const updated: EntryRow = {
    ...row,
    abnormal: false,
    pending: row.status !== '已修复' && row.status !== '已废弃',
    clock: { ...clock, recheck: 'done', recheckCompletedAt: at },
  }
  persist(rows, index, updated)
  return { ok: true, message: `复核节点已完成（${operator} ${at.replace('T', ' ')}），可继续确认稳定/修复` }
}

// 确认稳定：同一测点重复提交只生效一次。
export function confirmStable(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，稳定结论不能重复提交' }
  }
  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (clock.stableConfirmed) {
    return { ok: false, message: `该测点已于 ${clock.stableConfirmedAt?.replace('T', ' ')} 确认稳定，重复提交只生效一次` }
  }
  if (clock.recheck !== 'done') {
    return { ok: false, message: '请先完成复核，再确认稳定' }
  }
  const rate = toNumber(row['变化速率'])
  if (rate !== null && rate >= RATE_REVIEW) {
    return { ok: false, message: '最近一次变化速率仍高于复核线，不能确认稳定' }
  }
  const updated: EntryRow = {
    ...row,
    status: '趋于稳定',
    abnormal: false,
    pending: true,
    clock: { ...clock, stableConfirmed: true, stableConfirmedAt: at },
  }
  persist(rows, index, updated)
  return { ok: true, message: `稳定结论已确认（${operator} ${at.replace('T', ' ')}），无需重复提交` }
}

function createClosureTask(row: EntryRow): EntryRow {
  const patrol = listRows(PATROL_KEY)
  const nextId = patrol.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const seq = String(nextId).padStart(4, '0')
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return {
    id: nextId,
    status: PATROL_TYPE,
    pending: true,
    abnormal: false,
    '巡查编号': `PATR-XC${seq}`,
    '隐患点编号': String(row['隐患点编号'] ?? ''),
    '巡查日期': date,
    '巡查人员': '待指派',
    '巡查范围': `裂缝测点 ${String(row['测点编号'] ?? '')} 修复后现场复查`,
    '发现异常': '待复查',
    '处置措施': PATROL_TYPE,
    '巡查状态': PATROL_TYPE,
    '来源测点': String(row['测点编号'] ?? ''),
  }
}

// 确认修复：时钟终点。完成后向巡查排查派发销号复查任务（同一测点只派一张未完成单）。
export function confirmRepaired(id: number, operator: string): ActionResult {
  let ctx
  try {
    ctx = findCrack(id)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测点读取失败' }
  }
  const { rows, index, row } = ctx
  const clock = ctx.clock

  const at = nowText()
  const blocked = assertAfterLastObservation(clock, at, '系统时间')
  if (blocked) {
    return blocked
  }
  if (row.status === '已修复') {
    return { ok: false, message: '测点已确认修复，不能重复确认' }
  }
  if (!clock.talkRepairAt) {
    return { ok: false, message: '请先完成约谈修复节点' }
  }
  if (clock.recheck !== 'done') {
    return { ok: false, message: '复核节点尚未完成，不能确认修复' }
  }
  if (!clock.stableConfirmed) {
    return { ok: false, message: '尚未确认稳定，不能确认修复' }
  }

  const patrol = listRows(PATROL_KEY)
  const source = String(row['测点编号'] ?? '')
  const openClosure = patrol.some(
    (item) =>
      String(item['处置措施'] ?? '') === PATROL_TYPE &&
      String(item['来源测点'] ?? '') === source &&
      item.status !== '已处置',
  )
  const nextPatrol = openClosure ? patrol : [...patrol, createClosureTask(row)]
  saveRows(PATROL_KEY, nextPatrol)

  const updated: EntryRow = {
    ...row,
    status: '已修复',
    abnormal: false,
    pending: false,
    clock: { ...clock, repairedConfirmedAt: at },
  }
  persist(rows, index, updated)
  return {
    ok: true,
    message: openClosure
      ? `修复已确认（${operator} ${at.replace('T', ' ')}），销号复查任务此前已派发`
      : `修复已确认（${operator} ${at.replace('T', ' ')}），已向巡查排查派发销号复查任务`,
  }
}

// 销号复查任务的动作护栏：只允许「确认处置」收尾，不允许从复查态倒退到巡查/异常态。
export function guardClosureAction(row: EntryRow, action: string): ActionResult | null {
  if (String(row['处置措施'] ?? '') !== PATROL_TYPE) {
    return null
  }
  if (row.status === '已处置') {
    return { ok: false, message: '销号复查已完成，不能重复操作' }
  }
  if (action !== '确认处置') {
    return { ok: false, message: '销号复查任务只能通过「确认处置」完成销号，不能倒退到其他巡查节点' }
  }
  return null
}

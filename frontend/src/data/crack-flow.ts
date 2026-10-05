import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

// 裂缝处置时钟：以测点为主轴串起「首次异常 → 最近观测 → 约谈修复 → 复核」四个节点。
// 数据仍落在 local-store（localStorage）里，与各列表页共用同一条数据流。

export const CRACK_KEY = 'crack'
export const PATROL_KEY = 'patrol'

// 宽度复核红线：宽度达到该值即触发复核。
// 与变化速率互相矛盾时以宽度为准（速率平缓但宽度到线，照样复核；速率单独偏大只算加速发展）。
const REVIEW_WIDTH_MM = 10
const ALERT_WIDTH_MM = 5
const ACCEL_RATE_MM_PER_D = 1

// 处置时钟上的四个节点，顺序即处置先后，已完成节点不允许倒退。
export type ClockNodeKey = 'firstAbnormal' | 'latestObservation' | 'interviewRepair' | 'review'

export type ClockNodeState = 'done' | 'active' | 'pending'

export type ClockNode = {
  key: ClockNodeKey
  label: string
  time: string
  detail: string
  state: ClockNodeState
}

export type CrackAction =
  | '记录数据'
  | '安排加测'
  | '标记加速'
  | '约谈修复'
  | '确认稳定'
  | '确认修复'
  | '销号复核'

export type CrackObservationInput = {
  observedAt: string
  width: string
  rate: string
}

function findCrack(id: number): { rows: EntryRow[]; index: number } | null {
  const rows = listRows(CRACK_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { rows, index }
}

function persist(rows: EntryRow[]): void {
  saveRows(CRACK_KEY, rows)
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function parseMeasure(value: unknown): number {
  const raw = text(value)
  if (raw === '') {
    return Number.NaN
  }
  return Number(raw)
}

// 旧测点可能没有初始宽度：保留为空，不参与任何计算。
export function initialWidth(row: EntryRow): string {
  return text(row['初始宽度'])
}

function timeOf(value: unknown): number {
  const time = new Date(text(value)).getTime()
  return Number.isNaN(time) ? 0 : time
}

function reject(message: string): ActionResult {
  return { ok: false, message }
}

function patch(row: EntryRow, changes: Record<string, string | number | boolean>): EntryRow {
  return { ...row, ...changes }
}

function isTerminal(status: string): boolean {
  return status === '已销号' || status === '已废弃'
}

function severity(status: string): number {
  if (status === '待复核') return 2
  if (status === '加速发展') return 1
  return 0
}

// 销号复查任务写在巡查排查模块里，确认修复后由系统自动追加，处置完成后才能回到裂缝页销号。
function findReviewTask(pointCode: string): EntryRow | undefined {
  return listRows(PATROL_KEY).find(
    (row) => text(row['任务类型']) === '销号复查' && text(row['关联测点']) === pointCode,
  )
}

function createReviewTask(row: EntryRow, now: string): string {
  const patrolRows = listRows(PATROL_KEY)
  const pointCode = text(row['测点编号'])
  const existing = findReviewTask(pointCode)
  if (existing) {
    return text(existing['巡查编号'])
  }
  const nextId = patrolRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const code = `XFHC-${String(nextId).padStart(4, '0')}`
  patrolRows.push({
    id: nextId,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: code,
    隐患点编号: text(row['隐患点编号']),
    巡查日期: now.slice(0, 10),
    巡查人员: '值班管理员',
    巡查范围: `裂缝测点 ${pointCode}`,
    发现异常: `裂缝测点 ${pointCode} 已确认修复，需现场销号复查`,
    处置措施: '',
    巡查状态: '待巡查',
    任务类型: '销号复查',
    关联测点: pointCode,
  })
  saveRows(PATROL_KEY, patrolRows)
  return code
}

// 记录一次观测（含加测）：观测时间不得早于上一次观测，节点只前进不倒退。
function recordObservation(row: EntryRow, input: CrackObservationInput): ActionResult {
  if (isTerminal(text(row.status))) {
    return reject(`测点已${text(row.status)}，不再接收观测数据`)
  }
  const observedAt = text(input.observedAt)
  if (!observedAt) {
    return reject('请填写观测时间')
  }
  const observedTime = new Date(observedAt).getTime()
  if (Number.isNaN(observedTime)) {
    return reject('观测时间格式不正确')
  }
  const lastObservation = timeOf(row['最近观测时间'])
  if (lastObservation && observedTime < lastObservation) {
    return reject('观测时间早于上次观测，不能倒退补录')
  }

  const width = parseMeasure(input.width)
  if (Number.isNaN(width)) {
    return reject('请填写有效的裂缝宽度（毫米）')
  }
  const rateRaw = text(input.rate)
  const rate = rateRaw === '' ? Number.NaN : Number(rateRaw)
  if (rateRaw !== '' && Number.isNaN(rate)) {
    return reject('变化速率需为数字（毫米/天）')
  }

  const changes: Record<string, string | number | boolean> = {
    最近观测时间: observedAt,
    当前宽度: width,
  }
  if (!Number.isNaN(rate)) {
    changes['变化速率'] = rate
  }

  const firstAbnormalTime = text(row['首次异常时间'])
  const wideAlert = width >= ALERT_WIDTH_MM
  const fast = !Number.isNaN(rate) && rate >= ACCEL_RATE_MM_PER_D
  if (!firstAbnormalTime && (wideAlert || fast)) {
    changes['首次异常时间'] = observedAt
  }

  // 宽度与速率矛盾时以宽度为准：宽度到复核红线，速率再小也进入待复核。
  const current = text(row.status)
  if (current !== '趋于稳定' && current !== '已修复') {
    const derived = width >= REVIEW_WIDTH_MM ? '待复核' : wideAlert || fast ? '加速发展' : '正常'
    const nextStatus = severity(current) >= severity(derived) ? current : derived
    changes['status'] = nextStatus
    changes['abnormal'] = nextStatus === '加速发展' || nextStatus === '待复核'
    if (width >= REVIEW_WIDTH_MM) {
      changes['复核触发依据'] = `当前宽度 ${width}mm 达到 ${REVIEW_WIDTH_MM}mm 复核红线`
    }
  }

  const next = patch(row, changes)
  return saveCrack(next, () => {
    if (width >= REVIEW_WIDTH_MM) {
      return { ok: true, message: `观测已记录：宽度 ${width}mm 达到复核红线，测点转「待复核」` }
    }
    return { ok: true, message: '观测数据已记录' }
  })
}

function saveCrack(next: EntryRow, message: () => ActionResult): ActionResult {
  const found = findCrack(Number(next.id))
  if (!found) {
    return reject('没有找到该裂缝测点')
  }
  const rows = [...found.rows]
  rows[found.index] = next
  persist(rows)
  return message()
}

// 带系统时间的节点动作：系统时间早于上次观测一律拒绝。
function guardSystemTime(row: EntryRow, now: Date, label: string): ActionResult | null {
  if (Number.isNaN(now.getTime())) {
    return reject('系统时间不可用')
  }
  const lastObservation = timeOf(row['最近观测时间'])
  if (lastObservation && now.getTime() < lastObservation) {
    return reject(`系统时间早于上次观测时间，不能${label}`)
  }
  return null
}

export function runCrackAction(
  id: number,
  action: CrackAction,
  payload?: CrackObservationInput,
  now: Date = new Date(),
): ActionResult {
  const found = findCrack(id)
  if (!found) {
    return reject('没有找到该裂缝测点')
  }
  const row = found.rows[found.index]
  const current = text(row.status)

  if (action === '记录数据' || action === '安排加测') {
    if (!payload) {
      return reject(`${action}需要填写观测数据`)
    }
    return recordObservation(row, payload)
  }

  if (isTerminal(current)) {
    return reject(`测点已${current}，处置节点已闭环，不能再执行「${action}」`)
  }

  const stamp = now.toISOString()
  const timeError = guardSystemTime(row, now, action)
  if (timeError) {
    return timeError
  }

  if (action === '标记加速') {
    if (current === '加速发展' || current === '待复核') {
      return reject(`测点已是「${current}」，首次异常节点已完成`)
    }
    const changes: Record<string, string | number | boolean> = {
      status: '加速发展',
      abnormal: true,
      首次异常时间: text(row['首次异常时间']) || stamp,
    }
    return saveCrack(patch(row, changes), () => ({ ok: true, message: '已标记为加速发展，首次异常节点已记录' }))
  }

  if (action === '确认稳定') {
    // 同一测点重复提交确认稳定只生效一次（状态已变化时也给出明确原因）。
    if (text(row['稳定确认时间'])) {
      return reject('该测点已提交过确认稳定，重复提交只生效一次')
    }
    if (current !== '加速发展' && current !== '待复核') {
      return reject(`测点当前为「${current}」，只有异常处置中的测点可以确认稳定`)
    }
    const next = patch(row, { 稳定确认时间: stamp, status: '趋于稳定', abnormal: false })
    return saveCrack(next, () => ({ ok: true, message: '已确认趋于稳定' }))
  }

  if (action === '约谈修复') {
    if (current === '正常') {
      return reject('测点尚未出现首次异常，不能直接约谈修复')
    }
    if (text(row['约谈时间'])) {
      return reject('约谈节点已完成，不能重复约谈或倒退该节点')
    }
    const next = patch(row, { 约谈时间: stamp, 首次异常时间: text(row['首次异常时间']) || stamp })
    return saveCrack(next, () => ({ ok: true, message: '约谈修复节点已登记，等待现场修复确认' }))
  }

  if (action === '确认修复') {
    if (!text(row['约谈时间'])) {
      return reject('约谈修复节点尚未完成，不能直接确认修复')
    }
    if (text(row['修复时间'])) {
      return reject('修复节点已完成，不能重复确认修复')
    }
    const next = patch(row, { 修复时间: stamp, status: '已修复', abnormal: false, pending: true })
    const result = saveCrack(next, () => ({ ok: true, message: '修复已确认，已在巡查排查页生成销号复查任务' }))
    if (result.ok) {
      const code = createReviewTask(next, stamp)
      return { ok: true, message: `修复已确认，销号复查任务 ${code} 已下发至巡查排查页` }
    }
    return result
  }

  if (action === '销号复核') {
    if (current !== '已修复') {
      return reject(`测点当前为「${current}」，确认修复后才能销号复核`)
    }
    if (!text(row['修复时间'])) {
      return reject('修复节点尚未完成，不能复核')
    }
    const task = findReviewTask(text(row['测点编号']))
    if (!task) {
      return reject('缺少销号复查任务，请先在巡查排查页完成复查')
    }
    if (text(task.status) !== '已处置') {
      return reject(`销号复查任务 ${text(task['巡查编号'])} 尚未完成处置，暂不能复核销号`)
    }
    const reviewTime = timeOf(row['复核时间'])
    if (reviewTime && now.getTime() < reviewTime) {
      return reject('系统时间早于上次复核时间，不能倒退复核节点')
    }
    const next = patch(row, { 复核时间: stamp, status: '已销号', pending: false, abnormal: false })
    return saveCrack(next, () => ({ ok: true, message: '复核通过，测点已销号，处置时钟闭环' }))
  }

  return reject(`裂缝测点没有登记「${action}」这个动作`)
}

// 计算某测点在当前状态下可执行的动作入口（已完成节点不提供倒退入口）。
export function availableActions(row: EntryRow): CrackAction[] {
  switch (text(row.status)) {
    case '正常':
      return ['记录数据', '安排加测', '标记加速']
    case '加速发展':
      return ['记录数据', '安排加测', '约谈修复', '确认稳定']
    case '待复核':
      return ['记录数据', '安排加测', '约谈修复', '确认稳定']
    case '趋于稳定':
      return ['记录数据', '安排加测', '约谈修复']
    case '已修复':
      return ['销号复核']
    default:
      return []
  }
}

// 以测点为主轴组装处置时钟的四个节点。
export function buildClock(row: EntryRow): ClockNode[] {
  const status = text(row.status)
  const firstAbnormal = text(row['首次异常时间'])
  const latest = text(row['最近观测时间'])
  const interview = text(row['约谈时间'])
  const repaired = text(row['修复时间'])
  const reviewed = text(row['复核时间'])
  const reviewTask = findReviewTask(text(row['测点编号']))
  const taskStatus = reviewTask ? text(reviewTask.status) : ''

  const nodes: ClockNode[] = [
    {
      key: 'firstAbnormal',
      label: '首次异常',
      time: firstAbnormal,
      detail: firstAbnormal ? '宽度/速率首次越限' : '尚未出现异常',
      state: firstAbnormal ? 'done' : status === '正常' ? 'pending' : 'active',
    },
    {
      key: 'latestObservation',
      label: '最近观测',
      time: latest,
      detail: latest ? `宽度 ${text(row['当前宽度']) || '—'}mm` : '暂无观测记录',
      state: latest ? 'done' : 'active',
    },
    {
      key: 'interviewRepair',
      label: '约谈修复',
      time: repaired || interview,
      detail: repaired ? '已约谈并确认修复' : interview ? '已约谈，等待修复确认' : '未约谈',
      state: repaired ? 'done' : interview ? 'active' : 'pending',
    },
    {
      key: 'review',
      label: '复核',
      time: reviewed,
      detail: reviewed
        ? '复核通过，已销号'
        : repaired
          ? reviewTask
            ? `销号复查任务 ${text(reviewTask!['巡查编号'])}：${taskStatus}`
            : '等待生成销号复查任务'
          : '等待修复',
      state: reviewed ? 'done' : repaired ? 'active' : 'pending',
    },
  ]
  return nodes
}

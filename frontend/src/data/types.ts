/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 裂缝处置时钟的四个主轴节点：首次异常 → 最近观测 → 约谈修复 → 复核。
// 节点只允许向前推进，已完成的节点不能被清空或改写成更早的时间。
export type CrackRecheckState = 'none' | 'pending' | 'done'

export type CrackExtraPlan = {
  id: number
  scheduledAt: string
  reason: string
  status: '已安排' | '已完成'
  createdAt: string
  completedAt?: string
}

export type CrackObservation = {
  at: string
  width: number | null
  rate: number
  operator: string
}

export type CrackClock = {
  firstAbnormalAt: string | null
  lastObservedAt: string | null
  talkRepairAt: string | null
  recheck: CrackRecheckState
  recheckRequestedAt: string | null
  recheckCompletedAt: string | null
  recheckTrigger: 'rate' | 'manual' | null
  repairedConfirmedAt: string | null
  stableConfirmed: boolean
  stableConfirmedAt: string | null
  extras: CrackExtraPlan[]
  history: CrackObservation[]
}

export function emptyCrackClock(): CrackClock {
  return {
    firstAbnormalAt: null,
    lastObservedAt: null,
    talkRepairAt: null,
    recheck: 'none',
    recheckRequestedAt: null,
    recheckCompletedAt: null,
    recheckTrigger: null,
    repairedConfirmedAt: null,
    stableConfirmed: false,
    stableConfirmedAt: null,
    extras: [],
    history: [],
  }
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  clock?: CrackClock
  [field: string]: string | number | boolean | CrackClock | null | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

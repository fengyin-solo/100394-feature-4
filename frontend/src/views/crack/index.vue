<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝监测管理</h2>
        <p class="page-desc">以测点为主轴维护处置时钟：首次异常、最近观测、约谈修复、复核节点只进不退；操作员可安排加测，不能倒退已完成节点。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝测点</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-rule">
        复核规则：变化速率 ≥ 0.50 mm/d 必复核；宽度到线但速率平稳仅加速关注；旧测点缺初始宽度保留为空
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>处置时钟</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-selected': selectedId === Number(row.id) }">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>
            <span class="mini-clock">
              <i
                v-for="node in miniNodes(row)"
                :key="node.key"
                class="clock-dot"
                :class="`dot-${node.state}`"
                :title="`${node.label}：${node.text}`"
              />
              <em v-if="pendingExtras(row) > 0" class="extra-badge">加测×{{ pendingExtras(row) }}</em>
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openClock(row)">
              {{ selectedId === Number(row.id) ? '收起处置时钟' : '处置时钟' }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无裂缝监测数据，可先登记裂缝测点</td>
        </tr>
      </tbody>
    </table>

    <div v-if="selected" class="clock-panel">
      <div class="clock-head">
        <div>
          <h3>处置时钟 · {{ selected['测点编号'] }}（裂缝 {{ selected['裂缝编号'] }}）</h3>
          <p class="page-desc">
            隐患点 {{ selected['隐患点编号'] }} ｜ 当前状态：{{ selected.status }} ｜ 初始宽度：{{
              selected['初始宽度'] === '' || selected['初始宽度'] === undefined ? '空（旧测点未登记）' : selected['初始宽度'] + ' mm'
            }} ｜ 当前宽度：{{ selected['当前宽度'] === '' ? '—' : selected['当前宽度'] + ' mm' }} ｜
            变化速率：{{ selected['变化速率'] === '' ? '—' : selected['变化速率'] + ' mm/d' }}
          </p>
        </div>
        <button class="btn ghost" type="button" @click="selectedId = null">关闭</button>
      </div>

      <ol class="clock-track">
        <li v-for="node in clockNodes" :key="node.key" class="clock-node" :class="`is-${node.state}`">
          <span class="node-index">{{ node.order }}</span>
          <span class="node-label">{{ node.label }}</span>
          <time class="node-time">{{ node.text }}</time>
          <small v-if="node.hint" class="node-hint">{{ node.hint }}</small>
        </li>
      </ol>

      <p v-if="clock.recheck === 'pending'" class="clock-alert">
        复核待执行：{{
          clock.recheckTrigger === 'rate'
            ? `变化速率于 ${fmt(clock.recheckRequestedAt)} 达到复核线自动触发`
            : `人工于 ${fmt(clock.recheckRequestedAt)} 发起`
        }}，请尽快现场复核。
      </p>

      <div class="clock-actions">
        <button class="btn" type="button" :disabled="!can.markAcceleration" @click="run('markAcceleration')">标记加速（首次异常）</button>
        <button class="btn" type="button" :disabled="!can.talkRepair" @click="run('talkRepair')">约谈修复</button>
        <button class="btn" type="button" :disabled="!can.requestRecheck" @click="run('requestRecheck')">发起复核</button>
        <button class="btn" type="button" :disabled="!can.completeRecheck" @click="run('completeRecheck')">完成复核</button>
        <button class="btn" type="button" :disabled="!can.confirmStable" @click="run('confirmStable')">确认稳定</button>
        <button class="btn primary" type="button" :disabled="!can.confirmRepaired" @click="run('confirmRepaired')">确认修复并派销号复查</button>
      </div>

      <div class="clock-forms">
        <form class="clock-form" @submit.prevent="submitObservation">
          <h4>记录观测 / 落测</h4>
          <label><span>观测时间</span><input v-model="observeForm.at" type="datetime-local" /></label>
          <label><span>宽度(mm)</span><input v-model="observeForm.widthInput" inputmode="decimal" placeholder="旧测点可留空" /></label>
          <label><span>速率(mm/d)</span><input v-model="observeForm.rateInput" inputmode="decimal" /></label>
          <label><span>观测人</span><input v-model="observeForm.operator" /></label>
          <button class="btn" type="submit">提交观测</button>
        </form>

        <form class="clock-form" @submit.prevent="submitExtra">
          <h4>安排加测</h4>
          <label><span>计划时间</span><input v-model="extraForm.scheduledAt" type="datetime-local" /></label>
          <label class="grow"><span>加测原因</span><input v-model="extraForm.reason" placeholder="如：雨后加密观测" /></label>
          <button class="btn" type="submit">安排</button>
          <p class="form-hint">加测只能排未来计划，不能改写已完成节点；到点录入观测时自动闭合。</p>
        </form>
      </div>

      <div class="clock-lists">
        <section>
          <h4>加测计划（{{ clock.extras.length }}）</h4>
          <p v-if="!clock.extras.length" class="form-hint">暂无加测安排</p>
          <ul class="event-list">
            <li v-for="plan in [...clock.extras].reverse()" :key="plan.id">
              <span class="event-state" :class="plan.status === '已安排' ? 'state-plan' : 'state-done'">{{ plan.status }}</span>
              <span>{{ fmt(plan.scheduledAt) }} · {{ plan.reason }}</span>
              <small v-if="plan.completedAt">完成于 {{ fmt(plan.completedAt) }}</small>
            </li>
          </ul>
        </section>
        <section>
          <h4>观测历史（{{ clock.history.length }}）</h4>
          <p v-if="!clock.history.length" class="form-hint">暂无观测记录</p>
          <ul class="event-list">
            <li v-for="item in [...clock.history].reverse()" :key="item.at">
              <span class="event-state" :class="item.rate >= RATE_REVIEW ? 'state-hot' : 'state-ok'">
                {{ item.rate >= RATE_REVIEW ? '速率超线' : '平稳' }}
              </span>
              <span>{{ fmt(item.at) }} · 宽 {{ item.width === null ? '空' : item.width + 'mm' }} · 速 {{ item.rate }}mm/d</span>
              <small>{{ item.operator }}</small>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝监测记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  completeRecheck,
  confirmRepaired,
  confirmStable,
  listCracks,
  markAcceleration,
  recordObservation,
  requestRecheck,
  scheduleExtra,
  talkRepair,
} from '@/api/crack-service'
import { useSessionStore } from '@/stores/session'
import { emptyCrackClock } from '@/data/types'
import type { CrackClock, EntryRow } from '@/data/types'

const meta = moduleMeta('crack')
const store = useSessionStore()
const columns = ['测点编号', '隐患点编号', '裂缝编号', '初始宽度', '当前宽度', '变化速率', '监测人', '测点状态']
const statuses = ['正常', '加速发展', '趋于稳定', '已修复', '已废弃']
const RATE_REVIEW = 0.5

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedId = ref<number | null>(null)
const selected = computed(() => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null)
const clock = computed<CrackClock>(() =>
  selected.value?.clock && typeof selected.value.clock === 'object'
    ? { ...emptyCrackClock(), ...selected.value.clock }
    : emptyCrackClock(),
)

const observeForm = reactive({ at: '', widthInput: '', rateInput: '', operator: store.operator })
const extraForm = reactive({ scheduledAt: '', reason: '' })

const stats = computed(() => [
  { label: '测点总数', value: rows.value.length },
  { label: '加速发展数', value: rows.value.filter((row) => row.status === '加速发展').length },
  { label: '待复核测点数', value: rows.value.filter((row) => row.clock?.recheck === 'pending').length },
  { label: '已修复数', value: rows.value.filter((row) => row.status === '已修复').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function fmt(value: string | null | undefined): string {
  return value ? value.replace('T', ' ') : '—'
}

function displayCell(row: EntryRow, column: string): string | number {
  const value = row[column]
  if (value === '' || value === null || value === undefined) {
    return column === '初始宽度' ? '空' : '—'
  }
  return value as string | number
}

function nodeState(at: string | null | undefined): 'done' | 'empty' {
  return at ? 'done' : 'empty'
}

type MiniNode = { key: string; label: string; state: string; text: string }

function miniNodes(row: EntryRow): MiniNode[] {
  const c = row.clock && typeof row.clock === 'object' ? row.clock : emptyCrackClock()
  const recheckState = c.recheck === 'done' ? 'done' : c.recheck === 'pending' ? 'active' : 'empty'
  return [
    { key: 'first', label: '首次异常', state: nodeState(c.firstAbnormalAt), text: fmt(c.firstAbnormalAt) },
    { key: 'obs', label: '最近观测', state: nodeState(c.lastObservedAt), text: fmt(c.lastObservedAt) },
    { key: 'talk', label: '约谈修复', state: nodeState(c.talkRepairAt), text: fmt(c.talkRepairAt) },
    { key: 'recheck', label: '复核', state: recheckState, text: c.recheck === 'done' ? fmt(c.recheckCompletedAt) : c.recheck === 'pending' ? '待复核' : '未触发' },
  ]
}

function pendingExtras(row: EntryRow): number {
  if (!row.clock || typeof row.clock !== 'object') {
    return 0
  }
  return row.clock.extras.filter((plan) => plan.status === '已安排').length
}

type ClockNodeView = { key: string; order: string; label: string; state: string; text: string; hint?: string }

const clockNodes = computed<ClockNodeView[]>(() => [
  { key: 'first', order: '1', label: '首次异常', state: nodeState(clock.value.firstAbnormalAt), text: fmt(clock.value.firstAbnormalAt) },
  { key: 'obs', order: '2', label: '最近观测', state: nodeState(clock.value.lastObservedAt), text: fmt(clock.value.lastObservedAt) },
  { key: 'talk', order: '3', label: '约谈修复', state: nodeState(clock.value.talkRepairAt), text: fmt(clock.value.talkRepairAt) },
  {
    key: 'recheck',
    order: '4',
    label: '复核',
    state: clock.value.recheck === 'done' ? 'done' : clock.value.recheck === 'pending' ? 'active' : 'empty',
    text:
      clock.value.recheck === 'done'
        ? fmt(clock.value.recheckCompletedAt)
        : clock.value.recheck === 'pending'
          ? `待复核（${clock.value.recheckTrigger === 'rate' ? '速率触发' : '人工发起'}）`
          : '未触发',
    hint:
      clock.value.recheck !== 'none'
        ? `发起于 ${fmt(clock.value.recheckRequestedAt)}`
        : undefined,
  },
])

// 每个按钮的可用性同时是前端提示；真正的「不能倒退」硬校验在 crack-service 里。
const can = computed(() => {
  const c = clock.value
  const status = selected.value?.status
  const frozen = status === '已修复'
  return {
    markAcceleration: !frozen && !c.firstAbnormalAt,
    talkRepair: !frozen && !!c.firstAbnormalAt && !c.talkRepairAt,
    requestRecheck: !frozen && c.recheck === 'none',
    completeRecheck: c.recheck === 'pending',
    confirmStable: !frozen && !c.stableConfirmed && c.recheck === 'done',
    confirmRepaired:
      !frozen && !!c.talkRepairAt && c.recheck === 'done' && c.stableConfirmed && !c.repairedConfirmedAt,
  }
})

function notice(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    reload()
  }
}

function openClock(row: EntryRow) {
  const id = Number(row.id)
  selectedId.value = selectedId.value === id ? null : id
  message.value = ''
}

type ClockAction =
  | 'markAcceleration'
  | 'talkRepair'
  | 'requestRecheck'
  | 'completeRecheck'
  | 'confirmStable'
  | 'confirmRepaired'

function run(action: ClockAction) {
  if (selectedId.value === null) {
    return
  }
  const handlers = {
    markAcceleration: () => markAcceleration(selectedId.value as number, store.operator),
    talkRepair: () => talkRepair(selectedId.value as number, store.operator),
    requestRecheck: () => requestRecheck(selectedId.value as number, store.operator),
    completeRecheck: () => completeRecheck(selectedId.value as number, store.operator),
    confirmStable: () => confirmStable(selectedId.value as number, store.operator),
    confirmRepaired: () => confirmRepaired(selectedId.value as number, store.operator),
  }
  notice(handlers[action]())
}

function submitObservation() {
  if (selectedId.value === null) {
    return
  }
  notice(
    recordObservation({
      id: selectedId.value,
      at: observeForm.at,
      widthInput: observeForm.widthInput,
      rateInput: observeForm.rateInput,
      operator: observeForm.operator || store.operator,
    }),
  )
  observeForm.at = ''
  observeForm.widthInput = ''
  observeForm.rateInput = ''
}

function submitExtra() {
  if (selectedId.value === null) {
    return
  }
  notice(
    scheduleExtra({
      id: selectedId.value,
      scheduledAt: extraForm.scheduledAt,
      reason: extraForm.reason,
      operator: store.operator,
    }),
  )
  extraForm.scheduledAt = ''
  extraForm.reason = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  message.value = '裂缝测点登记入口尚未接入审批流'
  messageOk.value = false
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    // 服务层以全部测点做时钟落库，列表筛选只影响展示。
    rows.value = payload.items
    total.value = payload.total
    if (selectedId.value !== null) {
      const stillExists = listCracks().some((row) => Number(row.id) === selectedId.value)
      if (!stillExists) {
        selectedId.value = null
      }
    }
  } catch (error) {
    message.value = error instanceof Error ? error.message : '裂缝监测列表读取失败'
    messageOk.value = false
  }
}

onMounted(reload)
</script>

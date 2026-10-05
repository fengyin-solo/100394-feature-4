<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝监测管理</h2>
        <p class="page-desc">以测点为主轴的处置时钟：按首次异常、最近观测、约谈修复、复核四个节点推进，已完成节点不能倒退；可安排加测，宽度达到复核红线即转复核。</p>
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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <article v-for="row in rows" :key="String(row.id)" class="clock-card" :class="`is-${row.status}`">
      <header class="clock-head">
        <div class="clock-id">
          <strong>{{ String(row['测点编号']) }}</strong>
          <span class="clock-sub">隐患点 {{ String(row['隐患点编号']) }} · 裂缝 {{ String(row['裂缝编号']) }}</span>
          <span v-if="String(row['复核触发依据'])" class="clock-reason">{{ String(row['复核触发依据']) }}</span>
        </div>
        <div class="clock-meta">
          <span class="clock-badge" :data-status="String(row.status)">{{ row.status }}</span>
          <span class="clock-sub">监测人：{{ String(row['监测人'] ?? '—') }}</span>
        </div>
      </header>

      <div class="clock-readings">
        <span>初始宽度：<strong>{{ row['初始宽度'] === '' || row['初始宽度'] == null ? '空（旧测点无初始值）' : `${row['初始宽度']} mm` }}</strong></span>
        <span>当前宽度：<strong>{{ row['当前宽度'] ?? '—' }}{{ row['当前宽度'] != null ? ' mm' : '' }}</strong></span>
        <span>变化速率：<strong>{{ row['变化速率'] ?? '—' }}{{ row['变化速率'] != null ? ' mm/天' : '' }}</strong></span>
      </div>

      <ol class="clock-line">
        <li v-for="(node, nodeIndex) in clockOf(row)" :key="node.key" class="clock-node" :data-state="node.state">
          <span class="clock-dot" />
          <div class="clock-info">
            <span class="clock-node-label">{{ node.label }}</span>
            <span class="clock-node-time">{{ formatTime(node.time) }}</span>
            <span class="clock-node-detail">{{ node.detail }}</span>
          </div>
          <i v-if="nodeIndex < 3" class="clock-arrow">→</i>
        </li>
      </ol>

      <footer class="clock-actions">
        <button
          v-for="action in actionList(row)"
          :key="action"
          class="link"
          type="button"
          @click="runAction(action, row)"
        >
          {{ action }}
        </button>
      </footer>
    </article>

    <p v-if="!rows.length" class="empty-state clock-empty">暂无裂缝监测数据，可先登记裂缝测点</p>

    <div v-if="observing" class="modal-mask" @click.self="closeObserve">
      <div class="modal">
        <h3>{{ observing.action }} · {{ String(observing.row['测点编号']) }}</h3>
        <p class="modal-hint">观测时间早于上次观测（{{ formatTime(String(observing.row['最近观测时间'] ?? '')) }}）将被拒绝。</p>
        <label class="modal-field">
          <span>观测时间</span>
          <input v-model="observing.observedAt" type="datetime-local" />
        </label>
        <label class="modal-field">
          <span>裂缝宽度（mm）</span>
          <input v-model="observing.width" type="number" step="0.1" placeholder="当前宽度" />
        </label>
        <label class="modal-field">
          <span>变化速率（mm/天，可留空）</span>
          <input v-model="observing.rate" type="number" step="0.01" placeholder="变化速率" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeObserve">取消</button>
          <button class="btn primary" type="button" @click="submitObserve">提交观测</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  availableActions,
  buildClock,
  runCrackAction,
  type ClockNode,
  type CrackAction,
  type CrackObservationInput,
} from '@/data/crack-flow'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crack')
const columns = ['测点编号', '隐患点编号', '裂缝编号']
const statuses = ['正常', '加速发展', '待复核', '趋于稳定', '已修复', '已销号', '已废弃']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

type ObserveState = {
  row: EntryRow
  action: CrackAction
  observedAt: string
  width: string
  rate: string
}
const observing = ref<ObserveState | null>(null)

const stats = computed(() => [
  { label: '测点总数', value: rows.value.length },
  { label: '加速发展数', value: rows.value.filter((row) => String(row.status) === '加速发展').length },
  { label: '待复核数', value: rows.value.filter((row) => String(row.status) === '待复核').length },
  {
    label: '销号复查待办',
    value: rows.value.filter((row) => String(row.status) === '已修复').length,
  },
])

const statusSummary = computed(() =>
  statuses
    .map((status: string) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length }))
    .filter((item) => item.count > 0),
)

function clockOf(row: EntryRow): ClockNode[] {
  return buildClock(row)
}

function actionList(row: EntryRow): CrackAction[] {
  return availableActions(row)
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) {
    return value
  }
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '裂缝测点登记入口尚未接入审批流'
}

function openObserve(row: EntryRow, action: CrackAction) {
  const now = new Date()
  const pad = (num: number) => String(num).padStart(2, '0')
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  observing.value = {
    row,
    action,
    observedAt: local,
    width: String(row['当前宽度'] ?? ''),
    rate: String(row['变化速率'] ?? ''),
  }
}

function closeObserve() {
  observing.value = null
}

function submitObserve() {
  const state = observing.value
  if (!state) {
    return
  }
  const payload: CrackObservationInput = {
    observedAt: state.observedAt,
    width: state.width,
    rate: state.rate,
  }
  const result = runCrackAction(Number(state.row.id), state.action, payload)
  closeObserve()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function runAction(action: CrackAction, row: EntryRow) {
  errorMessage.value = ''
  if (action === '记录数据' || action === '安排加测') {
    openObserve(row, action)
    return
  }
  const result = runCrackAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝监测列表读取失败'
  }
}

onMounted(reload)
</script>

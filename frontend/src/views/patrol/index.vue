<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡查排查管理</h2>
        <p class="page-desc">维护巡查记录，围绕巡查编号、隐患点编号、巡查日期、巡查人员做登记、筛选与状态流转；裂缝测点确认修复后自动生成销号复查任务。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡查记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡查排查清单</button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>任务类型</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-closure': isClosure(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="isClosure(row)" class="tag tag-closure">销号复查</span>
            <span v-else class="tag tag-routine">日常巡查</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无巡查排查数据，可先登记巡查记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡查排查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡查编号', '隐患点编号', '巡查日期', '巡查人员', '巡查范围', '发现异常', '处置措施', '巡查状态']
const statuses = ['待巡查', '已巡查', '发现异常', '销号复查', '已处置']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

function isClosure(row: EntryRow): boolean {
  // 裂缝确认修复派发的任务：处置措施固定写「销号复查」。
  return String(row['处置措施'] ?? '') === '销号复查'
}

function rowActions(row: EntryRow): string[] {
  if (isClosure(row)) {
    // 销号复查只能一路走到确认处置，不能倒退回巡查/异常节点。
    return row.status === '已处置' ? [] : ['确认处置']
  }
  return ['完成巡查', '报告异常', '确认处置']
}

const stats = computed(() => [
  { label: '本月巡查次数', value: rows.value.length },
  { label: '发现异常数', value: rows.value.filter((row) => String(row.status) === '发现异常').length },
  {
    label: '待销号复查数',
    value: rows.value.filter((row) => isClosure(row) && String(row.status) !== '已处置').length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡查记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡查排查列表读取失败'
  }
}

onMounted(reload)
</script>

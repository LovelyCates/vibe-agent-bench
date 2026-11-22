<script setup>
import { onMounted, ref } from 'vue';

const statusLabels = {
  pending: '待处理',
  running: '进行中',
  completed: '已完成',
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
});

const keyword = ref('');
const submittedKeyword = ref('');
const tasks = ref([]);
const loading = ref(true);
const error = ref('');
let requestVersion = 0;

async function loadTasks() {
  const version = ++requestVersion;
  const params = new URLSearchParams();
  if (submittedKeyword.value) params.set('q', submittedKeyword.value);
  const query = params.size ? `?${params}` : '';

  loading.value = true;
  error.value = '';
  try {
    const result = await fetch(`/api/tasks${query}`);
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    const payload = await result.json();
    if (version === requestVersion) tasks.value = payload.items;
  } catch {
    if (version === requestVersion) error.value = '读取任务失败，请重试。';
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function submitSearch() {
  submittedKeyword.value = keyword.value.trim();
  return loadTasks();
}

onMounted(loadTasks);
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <span
        class="workspace-mark"
        aria-hidden="true"
      >运</span>
      <span>运维工作台</span>
    </div>
  </header>
  <main>
    <div class="page-heading">
      <h1>任务看板</h1>
      <p>查看任务进度、负责人和最近更新时间。</p>
    </div>
    <section
      class="task-panel"
      aria-labelledby="task-list-heading"
    >
      <div class="panel-heading">
        <h2 id="task-list-heading">
          任务列表
        </h2>
        <span
          v-if="!loading && !error"
          class="task-count"
          aria-live="polite"
        >{{ tasks.length }} 项任务</span>
      </div>
      <form
        class="controls"
        @submit.prevent="submitSearch"
      >
        <label for="keyword">关键字</label>
        <input
          id="keyword"
          v-model="keyword"
          type="search"
          placeholder="任务编号、名称或负责人"
        >
        <button type="submit">
          搜索
        </button>
      </form>
      <div
        class="results"
        :aria-busy="loading"
      >
        <p
          v-if="loading"
          class="result-message"
          role="status"
        >
          正在加载任务…
        </p>
        <div
          v-else-if="error"
          class="result-message"
        >
          <p role="alert">
            {{ error }}
          </p>
          <button
            type="button"
            @click="loadTasks"
          >
            重试
          </button>
        </div>
        <p
          v-else-if="!tasks.length"
          id="empty-state"
          class="result-message"
          role="status"
        >
          暂无匹配任务
        </p>
        <table v-else>
          <thead>
            <tr>
              <th scope="col">
                任务
              </th>
              <th scope="col">
                负责人
              </th>
              <th scope="col">
                状态
              </th>
              <th scope="col">
                最近更新
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="task in tasks"
              :key="task.id"
              :data-task-id="task.id"
            >
              <td>
                <strong class="task-title">{{ task.title }}</strong>
                <span class="task-id">{{ task.id }}</span>
              </td>
              <td>{{ task.owner }}</td>
              <td>
                <span
                  class="task-status"
                  :class="task.status"
                >{{ statusLabels[task.status] }}</span>
              </td>
              <td>
                <time :datetime="task.updatedAt">{{ dateFormat.format(new Date(task.updatedAt)) }}</time>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

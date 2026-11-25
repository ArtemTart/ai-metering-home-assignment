<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import ActivityLog from './components/ActivityLog.vue';
import AssigneeView from './components/AssigneeView.vue';
import SummaryPanel from './components/SummaryPanel.vue';
import TaskEditor from './components/TaskEditor.vue';
import TaskList from './components/TaskList.vue';
import { connectToServer } from './connection.js';
import { useBoardStore } from './stores/board.js';

const store = useBoardStore();
let disconnect = () => {};
onMounted(() => (disconnect = connectToServer(store)));
onUnmounted(() => disconnect());

const CONNECTION_LABELS = { connecting: 'Connecting…', live: 'Live', offline: 'Offline, reconnecting…' };
</script>

<template>
  <header>
    <h1>Team Task Board</h1>
    <span class="connection" :class="store.connection">{{ CONNECTION_LABELS[store.connection] }}</span>
  </header>

  <div v-if="store.lastError" class="error-banner" role="alert">
    {{ store.lastError }}
    <button @click="store.lastError = null">Dismiss</button>
  </div>

  <main>
    <TaskList class="list" />
    <TaskEditor class="editor-panel" />
    <SummaryPanel class="summary-panel" />
    <AssigneeView class="assignees" />
    <ActivityLog class="log" />
  </main>
</template>

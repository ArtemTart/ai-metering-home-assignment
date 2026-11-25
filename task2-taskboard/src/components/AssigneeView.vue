<script setup lang="ts">
import { TEAM } from '../../shared/types.js';
import { STATUS_LABELS } from '../labels.js';
import { useBoardStore } from '../stores/board.js';

// Tasks grouped by person. Clicking a task selects it in the editor.
const store = useBoardStore();
</script>

<template>
  <section class="panel">
    <h2>By assignee</h2>
    <div class="groups">
      <div v-for="person in TEAM" :key="person" :data-testid="`group-${person}`">
        <h3>{{ person }} ({{ store.tasksByAssignee[person].length }})</h3>
        <ul>
          <li v-for="task in store.tasksByAssignee[person]" :key="task.id" :class="{ selected: task.id === store.selectedId }">
            <button class="link" @click="store.select(task.id)">{{ task.title }}</button>
            <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
          </li>
          <li v-if="store.tasksByAssignee[person].length === 0" class="muted">No tasks</li>
        </ul>
      </div>
    </div>
  </section>
</template>

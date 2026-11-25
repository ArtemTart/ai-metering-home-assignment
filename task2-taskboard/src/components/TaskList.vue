<script setup lang="ts">
import { ref } from 'vue';
import { PRIORITIES, STATUSES, TEAM, type Assignee, type Priority, type Status } from '../../shared/types.js';
import { PRIORITY_LABELS, STATUS_LABELS } from '../labels.js';
import { useBoardStore } from '../stores/board.js';

// All tasks, with inline editing of status/assignee/priority, delete, and a form to add a task.
const store = useBoardStore();

const newTitle = ref('');
const newAssignee = ref<Assignee>(TEAM[0]);

async function addTask() {
  const title = newTitle.value.trim();
  if (!title || store.creating) return;
  const task = await store.createTask({ title, assignee: newAssignee.value, status: 'todo', priority: 'medium' });
  if (task) {
    newTitle.value = '';
    store.select(task.id);
  }
}
</script>

<template>
  <section class="panel">
    <h2>Tasks ({{ store.taskList.length }})</h2>

    <form class="add" @submit.prevent="addTask">
      <input v-model="newTitle" placeholder="New task title" maxlength="200" aria-label="New task title" :disabled="store.creating" />
      <select v-model="newAssignee" aria-label="New task assignee" :disabled="store.creating">
        <option v-for="person in TEAM" :key="person" :value="person">{{ person }}</option>
      </select>
      <button type="submit" :disabled="!newTitle.trim() || store.creating">{{ store.creating ? 'Adding…' : 'Add' }}</button>
    </form>

    <table>
      <thead>
        <tr><th>Title</th><th>Assignee</th><th>Status</th><th>Priority</th><th></th></tr>
      </thead>
      <tbody>
        <tr
          v-for="task in store.taskList"
          :key="task.id"
          :class="{ selected: task.id === store.selectedId, pending: store.isPending(task.id) }"
          :data-testid="`row-${task.id}`"
        >
          <td>
            <button class="link" @click="store.select(task.id)">{{ task.title }}</button>
            <span v-if="store.isPending(task.id)" class="saving" data-testid="saving">Saving…</span>
          </td>
          <td>
            <select
              :value="task.assignee"
              aria-label="Assignee"
              :disabled="store.isPending(task.id)"
              @change="store.updateTask(task.id, { assignee: ($event.target as HTMLSelectElement).value as Assignee })"
            >
              <option v-for="person in TEAM" :key="person" :value="person">{{ person }}</option>
            </select>
          </td>
          <td>
            <select
              :value="task.status"
              aria-label="Status"
              :disabled="store.isPending(task.id)"
              @change="store.updateTask(task.id, { status: ($event.target as HTMLSelectElement).value as Status })"
            >
              <option v-for="status in STATUSES" :key="status" :value="status">{{ STATUS_LABELS[status] }}</option>
            </select>
          </td>
          <td>
            <select
              :value="task.priority"
              aria-label="Priority"
              :disabled="store.isPending(task.id)"
              @change="store.updateTask(task.id, { priority: ($event.target as HTMLSelectElement).value as Priority })"
            >
              <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ PRIORITY_LABELS[priority] }}</option>
            </select>
          </td>
          <td>
            <button class="danger" aria-label="Delete" :disabled="store.isPending(task.id)" @click="store.deleteTask(task.id)">✕</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="store.taskList.length === 0" class="muted">No tasks yet.</p>
  </section>
</template>

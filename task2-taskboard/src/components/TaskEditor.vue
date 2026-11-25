<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { PRIORITIES, STATUSES, TEAM, type NewTask, type TaskPatch } from '../../shared/types.js';
import { PRIORITY_LABELS, STATUS_LABELS } from '../labels.js';
import { useBoardStore } from '../stores/board.js';

// Edits the selected task. Changes are kept in a local draft until "Save", so typing a title doesn't
// broadcast every keystroke; on save only the fields the user actually changed are sent.
const store = useBoardStore();

const fieldsOf = (t: NewTask): NewTask => ({ title: t.title, assignee: t.assignee, status: t.status, priority: t.priority });

/** The task as it was when editing started; the draft is compared to this to find what the user changed. */
const base = ref<NewTask | null>(null);
const draft = ref<NewTask | null>(null);
/** The selected task changed on the server while the user had unsaved edits. */
const changedRemotely = ref(false);

const changes = computed<TaskPatch>(() => {
  if (!base.value || !draft.value) return {};
  const patch: TaskPatch = {};
  for (const key of Object.keys(draft.value) as (keyof NewTask)[]) {
    if (draft.value[key] !== base.value[key]) Object.assign(patch, { [key]: draft.value[key] });
  }
  return patch;
});
const isDirty = computed(() => Object.keys(changes.value).length > 0);

function loadLatest() {
  const task = store.selectedTask;
  base.value = task ? fieldsOf(task) : null;
  draft.value = task ? fieldsOf(task) : null;
  changedRemotely.value = false;
}

// A different task was selected: start a fresh draft.
watch(() => store.selectedId, loadLatest, { immediate: true });

// The selected task changed elsewhere (another component, or the server). Without unsaved edits, just show
// the new values; with unsaved edits, keep the user's draft and tell them instead of silently overwriting it.
watch(
  () => store.selectedTask && fieldsOf(store.selectedTask),
  (latest) => {
    if (!latest) return;
    if (isDirty.value) changedRemotely.value = true;
    else loadLatest();
  },
);

async function save() {
  const task = store.selectedTask;
  if (!task || !draft.value || !isDirty.value || !draft.value.title.trim()) return;
  const patch = { ...changes.value };
  if (patch.title !== undefined) patch.title = patch.title.trim();
  // Mark the draft clean first, so the store update this triggers isn't mistaken for someone else's change.
  base.value = { ...draft.value };
  changedRemotely.value = false;
  await store.updateTask(task.id, patch);
  loadLatest(); // show what the server accepted (or the restored values if it refused)
}
</script>

<template>
  <section class="panel">
    <h2>Editor</h2>

    <p v-if="!store.selectedId" class="muted">Select a task to edit it.</p>
    <div v-else-if="!store.selectedTask" class="notice">
      This task was deleted.
      <button @click="store.select(null)">Close</button>
    </div>

    <form v-else-if="draft" class="editor" @submit.prevent="save">
      <div v-if="changedRemotely" class="notice">
        Someone else changed this task while you were editing.
        <button type="button" @click="loadLatest">Discard my changes and load theirs</button>
        <span class="muted">or save to apply only the fields you changed.</span>
      </div>

      <label>Title <input v-model="draft.title" maxlength="200" /></label>
      <span v-if="!draft.title.trim()" class="error">Title is required.</span>
      <label>
        Assignee
        <select v-model="draft.assignee">
          <option v-for="person in TEAM" :key="person" :value="person">{{ person }}</option>
        </select>
      </label>
      <label>
        Status
        <select v-model="draft.status">
          <option v-for="status in STATUSES" :key="status" :value="status">{{ STATUS_LABELS[status] }}</option>
        </select>
      </label>
      <label>
        Priority
        <select v-model="draft.priority">
          <option v-for="priority in PRIORITIES" :key="priority" :value="priority">{{ PRIORITY_LABELS[priority] }}</option>
        </select>
      </label>

      <div class="actions">
        <button type="submit" :disabled="!isDirty || !draft.title.trim()">Save</button>
        <button type="button" :disabled="!isDirty" @click="loadLatest">Cancel</button>
      </div>
    </form>
  </section>
</template>

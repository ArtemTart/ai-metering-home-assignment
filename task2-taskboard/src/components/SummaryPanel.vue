<script setup lang="ts">
import { STATUSES, TEAM } from '../../shared/types.js';
import { STATUS_LABELS } from '../labels.js';
import { useBoardStore } from '../stores/board.js';

// Counts by status and by assignee. Reads the store's computed counts; computes nothing itself.
const store = useBoardStore();
</script>

<template>
  <section class="panel">
    <h2>Summary</h2>
    <div class="summary">
      <dl data-testid="by-status">
        <template v-for="status in STATUSES" :key="status">
          <dt>{{ STATUS_LABELS[status] }}</dt>
          <dd :data-testid="`status-${status}`">{{ store.countsByStatus[status] }}</dd>
        </template>
      </dl>
      <dl data-testid="by-assignee">
        <template v-for="person in TEAM" :key="person">
          <dt>{{ person }}</dt>
          <dd :data-testid="`assignee-${person}`">{{ store.countsByAssignee[person] }}</dd>
        </template>
      </dl>
    </div>
  </section>
</template>

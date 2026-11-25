<script setup lang="ts">
import { useBoardStore } from '../stores/board.js';

// Feed of recent changes, newest first, from users and from the server.
const store = useBoardStore();
const time = (iso: string) => new Date(iso).toLocaleTimeString();
</script>

<template>
  <section class="panel">
    <h2>Activity</h2>
    <ul class="activity">
      <li v-for="entry in store.activity" :key="entry.id">
        <span class="muted">{{ time(entry.at) }}</span>
        <span class="badge" :class="entry.actor">{{ entry.actor === 'user' ? 'user' : 'server' }}</span>
        {{ entry.message }}
      </li>
      <li v-if="store.activity.length === 0" class="muted">No changes yet.</li>
    </ul>
  </section>
</template>

<script setup>
const { data, status, error, refresh, clear } = await useAsyncData(
    "mountains",
    () => $fetch("/api/test"),
);
</script>

<template>
    <div>Hello i am ssr</div>
    {{ data }}
</template>

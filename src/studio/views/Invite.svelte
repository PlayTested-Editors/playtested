<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { api } from "../api";
  import { loadSession, navigate, route } from "../state.svelte";

  const token = route.query.get("token") || "";
  let invite = $state<{ email: string; role: string; google: boolean } | null>(null);
  let error = $state("");
  let name = $state("");
  let busy = $state(false);

  const roleText: Record<string, string> = {
    chief: "Chief editor — reviews and publishes everything",
    editor: "Editor — edits any article and submits for review",
    contributor: "Contributor — writes their own articles for review",
  };

  onMount(async () => {
    try {
      invite = await api.get(`/invite/${encodeURIComponent(token)}`);
    } catch (e) {
      error = (e as Error).message;
    }
  });

  async function accept() {
    busy = true;
    try {
      await api.post("/auth/invite", { token, name });
      await loadSession();
      navigate("/studio/", true);
    } catch (e) {
      error = (e as Error).message;
      busy = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-sm" in:fly={{ y: 16, duration: 300 }}>
    <div class="mb-6 text-center">
      <img src="/playtested.png" alt="" class="mx-auto h-12 w-12 rounded-xl shadow-lg" />
      <h1 class="mt-4 text-xl font-bold">You're invited to PlayTested Studio</h1>
    </div>
    <div class="card p-6 space-y-4">
      {#if error}
        <div class="rounded-lg bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>
        <a href="/studio/login/" class="btn-secondary w-full">Go to sign-in</a>
      {:else if !invite}
        <p class="text-center text-sm text-slate-500">Checking your invite…</p>
      {:else}
        <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 text-sm">
          <p class="font-medium">{invite.email}</p>
          <p class="mt-0.5 text-slate-500 dark:text-slate-400">{roleText[invite.role] ?? invite.role}</p>
        </div>
        {#if invite.google}
          <a href={`/api/studio/auth/google/start?invite=${encodeURIComponent(token)}`} data-astro-prefetch="false" class="btn-primary w-full !py-2.5">Accept with Google</a>
          <p class="text-center text-xs text-slate-500">Sign in with the Google account for {invite.email}.</p>
        {:else}
          <div>
            <label class="label" for="nm">Your name</label>
            <input id="nm" class="input" bind:value={name} placeholder="How you'll appear in the studio" />
          </div>
          <button class="btn-primary w-full" disabled={busy} onclick={accept}>{busy ? "Joining…" : "Accept invite"}</button>
          <p class="text-xs text-slate-500">Later sign-ins use a link from the chief editor until Google sign-in is turned on.</p>
        {/if}
      {/if}
    </div>
  </div>
</div>

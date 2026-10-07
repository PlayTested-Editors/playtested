<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { api } from "../api";
  import { loadSession, navigate, route, session } from "../state.svelte";

  let error = $state(route.query.get("error") || "");
  let busy = $state(false);
  let showOwner = $state(!session.setup.hasUsers);
  let key = $state("");
  let email = $state("");
  let name = $state("");

  onMount(async () => {
    const link = route.query.get("link");
    if (link) {
      busy = true;
      try {
        await api.post("/auth/link", { token: link });
        await loadSession();
        navigate("/studio/", true);
      } catch (e) {
        error = (e as Error).message;
      } finally {
        busy = false;
      }
    }
  });

  async function ownerSignIn(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api.post("/auth/owner", { key, email, name });
      await loadSession();
      navigate("/studio/", true);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative min-h-screen overflow-hidden flex items-center justify-center px-4 py-12">
  <div class="pointer-events-none absolute inset-0 -z-10">
    <div class="absolute -top-40 left-1/2 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-500/25 via-fuchsia-500/15 to-transparent blur-3xl"></div>
  </div>
  <div class="w-full max-w-sm" in:fly={{ y: 16, duration: 300 }}>
    <div class="mb-8 text-center">
      <img src="/playtested.png" alt="" class="mx-auto h-12 w-12 rounded-xl shadow-lg" />
      <h1 class="mt-4 text-2xl font-bold tracking-tight">PlayTested Studio</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Write, review and publish.</p>
      {#if session.env && session.env !== "production"}
        <span class="mt-3 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{session.env} environment</span>
      {/if}
    </div>

    <div class="card p-6 space-y-4">
      {#if error}
        <div class="rounded-lg bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</div>
      {/if}

      {#if busy && route.query.get("link")}
        <p class="text-center text-sm text-slate-500">Signing you in…</p>
      {:else}
        {#if session.setup.google}
          <a href="/api/studio/auth/google/start" data-astro-prefetch="false" class="btn-secondary w-full !py-2.5">
            <svg class="h-4 w-4" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>
            Continue with Google
          </a>
        {:else}
          <p class="text-sm text-slate-600 dark:text-slate-300">
            Google sign-in isn't set up yet. Editors can sign in with a one-time link from the chief editor.
          </p>
        {/if}

        {#if session.setup.ownerKey}
          {#if !showOwner}
            <button class="w-full text-center text-xs font-medium text-slate-500 hover:text-indigo-600" onclick={() => (showOwner = true)}>
              Chief editor? Sign in with the owner key
            </button>
          {:else}
            <form class="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4" onsubmit={ownerSignIn}>
              <p class="text-xs text-slate-500 dark:text-slate-400">
                {session.setup.hasUsers ? "Owner sign-in (chief editor)." : "First-time setup: this creates your chief editor account."} Use the email of the Google account you'll sign in with later.
              </p>
              <div>
                <label class="label" for="email">Your email</label>
                <input id="email" class="input" type="email" required bind:value={email} autocomplete="email" />
              </div>
              {#if !session.setup.hasUsers}
                <div>
                  <label class="label" for="name">Your name</label>
                  <input id="name" class="input" bind:value={name} placeholder="Shown on articles you write" />
                </div>
              {/if}
              <div>
                <label class="label" for="key">Owner key</label>
                <input id="key" class="input font-mono" type="password" required bind:value={key} autocomplete="current-password" />
              </div>
              <button class="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
          {/if}
        {/if}
      {/if}
    </div>
    <p class="mt-6 text-center text-xs text-slate-500"><a href="/" class="hover:text-indigo-600">← Back to PlayTested.Net</a></p>
  </div>
</div>

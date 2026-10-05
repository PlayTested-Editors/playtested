<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { api } from "./api";
  import { applyTheme, loadSession, navigate, route, session, toastError } from "./state.svelte";
  import Toasts from "./ui/Toasts.svelte";
  import UploadTray from "./ui/UploadTray.svelte";
  import Shell from "./views/Shell.svelte";
  import Login from "./views/Login.svelte";
  import Invite from "./views/Invite.svelte";
  import Dashboard from "./views/Dashboard.svelte";
  import Articles from "./views/Articles.svelte";
  import Editor from "./views/Editor.svelte";
  import MediaLibrary from "./views/MediaLibrary.svelte";
  import Team from "./views/Team.svelte";
  import Settings from "./views/Settings.svelte";
  import Activity from "./views/Activity.svelte";
  import Comments from "./views/Comments.svelte";

  let failed = $state<string | null>(null);

  onMount(async () => {
    applyTheme();
    try {
      await loadSession();
    } catch (e) {
      failed = (e as Error).message;
    }
  });

  let view = $derived(route.parts[0] ?? "");
  let publicView = $derived(view === "login" || view === "invite");

  $effect(() => {
    if (!session.loaded) return;
    if (!session.user && !publicView) navigate("/studio/login/", true);
    if (session.user && view === "login" && !route.query.get("link")) navigate("/studio/", true);
  });

  // /studio/articles/new/ creates a draft and opens it.
  $effect(() => {
    if (session.user && view === "articles" && route.parts[1] === "new") {
      api
        .post<{ article: { id: string } }>("/articles", { data: {} })
        .then((d) => navigate(`/studio/articles/${d.article.id}/`, true))
        .catch((e) => {
          toastError(e);
          navigate("/studio/articles/", true);
        });
    }
  });
</script>

{#if failed}
  <div class="flex min-h-screen items-center justify-center p-6 text-center">
    <div>
      <p class="font-semibold">The studio couldn't load.</p>
      <p class="mt-1 text-sm text-slate-500">{failed}</p>
      <button class="btn-primary mt-4" onclick={() => location.reload()}>Try again</button>
    </div>
  </div>
{:else if !session.loaded}
  <div class="flex min-h-screen items-center justify-center">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"></div>
  </div>
{:else if view === "invite"}
  <Invite />
{:else if !session.user || view === "login"}
  <Login />
{:else}
  <Shell>
    {#key route.parts.join("/")}
      <div in:fade={{ duration: 150 }}>
        {#if view === ""}
          <Dashboard />
        {:else if view === "articles" && route.parts[1] && route.parts[1] !== "new"}
          <Editor id={route.parts[1]} />
        {:else if view === "articles"}
          {#if route.parts[1] !== "new"}<Articles />{/if}
        {:else if view === "media"}
          <MediaLibrary />
        {:else if view === "team"}
          <Team />
        {:else if view === "settings"}
          <Settings />
        {:else if view === "activity"}
          <Activity />
        {:else if view === "comments"}
          <Comments />
        {:else}
          <div class="p-12 text-center text-sm text-slate-500">Page not found. <a class="text-indigo-600" href="/studio/">Go to the dashboard</a></div>
        {/if}
      </div>
    {/key}
  </Shell>
{/if}

<Toasts />
<UploadTray />

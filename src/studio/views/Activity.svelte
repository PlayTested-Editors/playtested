<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api";
  import { dateTime, relTime } from "../format";
  import { toastError } from "../state.svelte";

  interface Item {
    id: number;
    action: string;
    target: string | null;
    meta: string | null;
    created_at: number;
    user_id: string | null;
    name: string | null;
    article_title: string | null;
  }
  let items = $state<Item[] | null>(null);

  const LABEL: Record<string, string> = {
    "article.create": "created an article",
    "article.publish": "published",
    "article.unpublish": "unpublished",
    "article.submit": "submitted for review",
    "article.approve": "approved",
    "article.request_changes": "requested changes on",
    "article.delete": "deleted a draft",
    "invite.create": "invited someone",
    "invite.accept": "joined the team",
    "invite.revoke": "revoked an invite",
    "user.update": "updated a team member",
    "user.login_link": "created a sign-in link",
    "user.bootstrap_chief": "set up the studio",
    "guards.update": "changed site limits",
    "watchdog.level": "Usage watchdog changed the site mode",
    "deploy.manual": "started a rebuild",
    "deploy.schedule": "Scheduler rebuilt the site for scheduled posts",
  };

  onMount(async () => {
    try {
      items = (await api.get<{ activity: Item[] }>("/activity?limit=150")).activity;
    } catch (e) {
      toastError(e);
    }
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-8 sm:px-6">
  <h1 class="mb-6 text-2xl font-bold tracking-tight">Activity</h1>
  <div class="card">
    {#if !items}
      <p class="p-6 text-sm text-slate-500">Loading…</p>
    {:else if !items.length}
      <p class="p-6 text-sm text-slate-500">Nothing yet.</p>
    {:else}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800">
        {#each items as i (i.id)}
          <li class="flex items-start gap-3 px-4 py-3 text-sm">
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full {i.action.includes('publish') ? 'bg-emerald-500' : i.action.startsWith('watchdog') ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
            <div class="flex-1">
              <p>
                {#if i.user_id}<strong>{i.name ?? "Someone"}</strong>{/if}
                {LABEL[i.action] ?? i.action}
                {#if i.article_title}<a class="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`/studio/articles/${i.target}/`}>{i.article_title}</a>{/if}
              </p>
              <p class="text-xs text-slate-500" title={dateTime(i.created_at)}>{relTime(i.created_at)}</p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

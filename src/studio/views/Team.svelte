<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { api, type Role } from "../api";
  import { relTime } from "../format";
  import { isChief, isEditorOrAbove, loadSession, navigate, session, toast, toastError } from "../state.svelte";
  import Modal from "../ui/Modal.svelte";

  interface Row {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    author_name: string | null;
    role: Role;
    status: "active" | "disabled";
    created_at: number;
    last_login_at: number | null;
  }
  interface Invite {
    id: string;
    email: string;
    role: Role;
    author_name: string | null;
    created_at: number;
    expires_at: number;
  }

  let users = $state<Row[] | null>(null);
  let invites = $state<Invite[]>([]);
  let inviteOpen = $state(false);
  let form = $state({ email: "", role: "contributor" as Role, authorName: "" });
  let linkResult = $state<{ title: string; url: string; note: string } | null>(null);
  let busy = $state(false);

  const ROLE: Record<Role, { label: string; text: string }> = {
    chief: { label: "Chief editor", text: "Final say: approves, publishes, manages the team and site limits." },
    editor: { label: "Editor", text: "Edits any article, leaves notes, submits for review." },
    contributor: { label: "Contributor", text: "Writes their own articles and submits them for review." },
  };

  async function load() {
    try {
      const r = await api.get<{ users: Row[]; invites: Invite[] }>("/users");
      users = r.users;
      invites = r.invites;
    } catch (e) {
      toastError(e);
    }
  }
  onMount(load);

  async function invite(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    try {
      const r = await api.post<{ url: string; expiresInDays: number }>("/invites", form);
      inviteOpen = false;
      linkResult = { title: `Invite for ${form.email}`, url: r.url, note: `Send this link to ${form.email}. It works once and expires in ${r.expiresInDays} days.` };
      form = { email: "", role: "contributor", authorName: "" };
      load();
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  /**
   * `control` is the input/select that made the change: if the server refuses,
   * it's put back to the saved value (re-rendering the same value won't).
   */
  async function update(u: Row, patch: Partial<{ role: Role; status: string; authorName: string }>, control?: HTMLInputElement | HTMLSelectElement) {
    try {
      await api.patch(`/users/${u.id}`, patch);
      toast("Updated", "success", undefined, 1500);
      // Changing your own role changes what this studio lets you do.
      if (u.id === session.user?.id) {
        await loadSession().catch(() => undefined);
        if (!isEditorOrAbove()) return navigate("/studio/", true);
      }
      load();
    } catch (e) {
      if (control) control.value = "role" in patch ? u.role : (u.author_name ?? "");
      toastError(e);
      load();
    }
  }

  async function signInLink(u: Row) {
    try {
      const r = await api.post<{ url: string; expiresInHours: number }>(`/users/${u.id}/login-link`);
      linkResult = { title: `Sign-in link for ${u.name}`, url: r.url, note: `Works once, for ${r.expiresInHours} hours. Handy until Google sign-in is set up, or if they lose access.` };
    } catch (e) {
      toastError(e);
    }
  }

  async function revoke(i: Invite) {
    try {
      await api.del(`/invites/${i.id}`);
      load();
    } catch (e) {
      toastError(e);
    }
  }
</script>

<div class="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Team</h1>
      <p class="mt-1 text-sm text-slate-500">Invite-only. Everyone signs in with Google (or a one-time link from you).</p>
    </div>
    {#if isChief()}<button class="btn-primary" onclick={() => (inviteOpen = true)}>Invite someone</button>{/if}
  </div>

  <div class="mb-8 grid gap-3 sm:grid-cols-3">
    {#each Object.entries(ROLE) as [key, r]}
      <div class="card p-4"><p class="text-sm font-semibold">{r.label}</p><p class="mt-1 text-xs text-slate-500">{r.text}</p></div>
    {/each}
  </div>

  <section class="card overflow-hidden">
    {#if !users}
      <p class="p-6 text-sm text-slate-500">Loading…</p>
    {:else}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800">
        {#each users as u (u.id)}
          <li class="flex flex-wrap items-center gap-4 px-4 py-3 {u.status === 'disabled' ? 'opacity-50' : ''}" in:fly={{ y: 6, duration: 150 }}>
            {#if u.avatar}
              <img src={u.avatar} alt="" class="h-9 w-9 rounded-full" referrerpolicy="no-referrer" />
            {:else}
              <div class="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white">{u.name[0]?.toUpperCase()}</div>
            {/if}
            <div class="min-w-[180px] flex-1">
              <p class="text-sm font-medium">{u.name}{u.id === session.user?.id ? " (you)" : ""}</p>
              <p class="text-xs text-slate-500">{u.email} · {u.last_login_at ? `active ${relTime(u.last_login_at)}` : "never signed in"}</p>
            </div>
            {#if isChief()}
              <input class="input !w-40 !py-1.5 !text-xs" placeholder="Byline name" value={u.author_name ?? ""} onchange={(e) => update(u, { authorName: e.currentTarget.value }, e.currentTarget)} title="Name written on their articles" />
              <select class="input !w-auto !py-1.5 !text-xs" value={u.role} onchange={(e) => update(u, { role: e.currentTarget.value as Role }, e.currentTarget)}>
                {#each Object.entries(ROLE) as [key, r]}<option value={key}>{r.label}</option>{/each}
              </select>
              <button class="btn-ghost !px-2 !py-1 text-xs" onclick={() => signInLink(u)}>Sign-in link</button>
              {#if u.id !== session.user?.id}
                <button class="btn-ghost !px-2 !py-1 text-xs {u.status === 'active' ? 'text-rose-600' : ''}" onclick={() => update(u, { status: u.status === "active" ? "disabled" : "active" })}>{u.status === "active" ? "Disable" : "Enable"}</button>
              {/if}
            {:else}
              <span class="text-xs font-medium text-slate-500">{ROLE[u.role].label}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if invites.length}
    <h2 class="mb-3 mt-8 text-sm font-semibold">Pending invites</h2>
    <ul class="card divide-y divide-slate-100 dark:divide-slate-800">
      {#each invites as i (i.id)}
        <li class="flex items-center gap-3 px-4 py-3 text-sm">
          <span class="flex-1">{i.email} <span class="text-xs text-slate-500">· {ROLE[i.role].label} · expires {relTime(i.expires_at)}</span></span>
          <button class="btn-ghost !py-1 text-xs text-rose-600" onclick={() => revoke(i)}>Revoke</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Modal bind:open={inviteOpen} title="Invite to the studio" size="sm">
  <form id="invite-form" class="space-y-4" onsubmit={invite}>
    <div>
      <label class="label" for="iv-email">Email (their Google account)</label>
      <input id="iv-email" class="input" type="email" required bind:value={form.email} />
    </div>
    <div>
      <label class="label" for="iv-role">Role</label>
      <select id="iv-role" class="input" bind:value={form.role}>
        {#each Object.entries(ROLE) as [key, r]}<option value={key}>{r.label} — {r.text}</option>{/each}
      </select>
    </div>
    <div>
      <label class="label" for="iv-author">Byline name <span class="normal-case font-normal">(optional)</span></label>
      <input id="iv-author" class="input" bind:value={form.authorName} placeholder="Name shown on their articles" />
    </div>
  </form>
  {#snippet footer()}
    <button class="btn-secondary" onclick={() => (inviteOpen = false)}>Cancel</button>
    <button class="btn-primary" form="invite-form" disabled={busy}>Create invite link</button>
  {/snippet}
</Modal>

<Modal open={linkResult !== null} title={linkResult?.title ?? ""} size="sm" onclose={() => (linkResult = null)}>
  {#if linkResult}
    <p class="mb-3 text-sm text-slate-600 dark:text-slate-300">{linkResult.note}</p>
    <div class="flex gap-2">
      <input class="input font-mono !text-xs" readonly value={linkResult.url} onfocus={(e) => e.currentTarget.select()} />
      <button class="btn-primary" onclick={async () => { await navigator.clipboard.writeText(linkResult!.url).catch(() => undefined); toast("Link copied", "success", undefined, 1500); }}>Copy</button>
    </div>
  {/if}
</Modal>

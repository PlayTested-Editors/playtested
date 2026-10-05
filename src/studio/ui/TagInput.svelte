<script lang="ts">
  let {
    value = $bindable<string[]>([]),
    suggestions = [],
    placeholder = "Add a tag…",
    disabled = false,
  }: { value?: string[]; suggestions?: string[]; placeholder?: string; disabled?: boolean } = $props();

  let text = $state("");
  let focused = $state(false);
  let matches = $derived(
    text.trim()
      ? suggestions.filter((s) => s.toLowerCase().includes(text.trim().toLowerCase()) && !value.includes(s)).slice(0, 8)
      : [],
  );

  function add(tag: string) {
    const t = tag.trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) value = [...value, t];
    text = "";
  }
  function remove(i: number) {
    value = value.filter((_, j) => j !== i);
  }
</script>

<div class="relative">
  <div
    class="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500/60 focus-within:border-indigo-500 transition"
  >
    {#each value as tag, i (tag)}
      <span class="inline-flex items-center gap-1 rounded-md bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
        {tag}
        {#if !disabled}
          <button type="button" class="text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-100" aria-label={`Remove ${tag}`} onclick={() => remove(i)}>×</button>
        {/if}
      </span>
    {/each}
    <input
      class="min-w-[8rem] flex-1 border-0 bg-transparent p-1 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-0"
      {placeholder}
      {disabled}
      bind:value={text}
      onfocus={() => (focused = true)}
      onblur={() => setTimeout(() => (focused = false), 120)}
      onkeydown={(e) => {
        if ((e.key === "Enter" || e.key === ",") && text.trim()) {
          e.preventDefault();
          add(matches[0] && e.key === "Enter" && matches[0].toLowerCase().startsWith(text.trim().toLowerCase()) ? matches[0] : text);
        } else if (e.key === "Backspace" && !text && value.length) {
          remove(value.length - 1);
        }
      }}
    />
  </div>
  {#if focused && matches.length}
    <ul class="absolute z-20 mt-1 w-full overflow-hidden rounded-lg bg-white dark:bg-slate-800 shadow-lg ring-1 ring-slate-900/10 dark:ring-white/10">
      {#each matches as m}
        <li>
          <button type="button" class="w-full px-3 py-1.5 text-left text-sm hover:bg-indigo-50 dark:hover:bg-slate-700" onmousedown={(e) => { e.preventDefault(); add(m); }}>{m}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

import { App, Component, MarkdownRenderChild, Notice, TFile, debounce, normalizePath, setIcon, setTooltip, type Events } from "obsidian";
import type { HabitStore } from "../habit-store";
import type { HabitsPluginSettings } from "../settings";
import type { HabitDefinition } from "../types";
import { t } from "../i18n";
import { flexiblePeriodTotal, isActive, isComplete, isFlexible, isPausedOn, limitOf } from "../stats";
import { addDays, friendlyDateLabel, groupHabits, habitAccent, parseNoteDate, sectionLabel, sortHabits, toDateKey } from "../utils";
import { createNoteHabitEntry, notePathForDate } from "../note-habit";
import { HabitModal } from "./habit-modal";
import { applyHabitIcon } from "./icon-suggest-modal";
import { renderStatsView } from "./stats-view";

/** Compact layout of the `habits` dashboard, with date navigation. */
export class HabitsCompact extends MarkdownRenderChild {
	private selectedDate = new Date();
	private stats = false;
	private active = false;
	private pending = new Set<string>();
	private savedValues = new Map<string, Map<string, number>>();
	private renderEvents: Component | null = null;

	constructor(
		private app: App,
		private store: HabitStore,
		private getSettings: () => HabitsPluginSettings,
		private pluginEvents: Events,
		private sourcePath: string,
		root: HTMLElement,
	) { super(root); }

	onload(): void {
		this.active = true;
		this.containerEl.addClass("habits-compact");
		const settings = this.getSettings();
		if (settings.followDailyNoteDate) {
			const name = (this.sourcePath.split("/").pop() ?? "").replace(/\.md$/, "");
			this.selectedDate = parseNoteDate(name, settings.dailyNoteDateFormat?.trim() || "YYYY-MM-DD") ?? new Date();
		}
		const refresh = debounce(() => this.render(), 250, true);
		const relevant = (path: string): boolean => {
			const folder = normalizePath(this.getSettings().habitsFolder);
			return path === folder || path.startsWith(`${folder}/`);
		};
		// Note habits can derive their completion from notes outside the habits folder.
		this.registerEvent(this.app.metadataCache.on("changed", file => {
			this.savedValues.delete(file.path);
			refresh();
		}));
		this.registerEvent(this.app.vault.on("create", () => refresh()));
		this.registerEvent(this.app.vault.on("delete", () => refresh()));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (relevant(file.path) || relevant(oldPath) || file instanceof TFile) refresh();
		}));
		this.registerEvent(this.pluginEvents.on("settings-changed", () => refresh()));
		this.render();
	}

	onunload(): void {
		this.active = false;
	}

	private button(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "habits-icon-button habits-compact-button",
			attr: { type: "button", "aria-label": label },
		});
		setIcon(button, icon);
		setTooltip(button, label);
		this.renderEvents?.registerDomEvent(button, "click", action);
		return button;
	}

	private render(): void {
		if (!this.active) return;
		if (this.renderEvents) this.removeChild(this.renderEvents);
		this.renderEvents = this.addChild(new Component());
		const root = this.containerEl;
		root.empty();
		const settings = this.getSettings();
		const habits = sortHabits(this.store.getHabits().filter(h => !h.stopped), settings.sortMode, settings.manualOrder, settings.groups, settings.groupOrder);
		// Bridge the delay between a successful disk write and metadata-cache refresh.
		for (const habit of habits) {
			for (const [key, value] of this.savedValues.get(habit.path) ?? []) {
				if (value > 0) habit.records[key] = value;
				else delete habit.records[key];
			}
		}
		const header = root.createDiv({ cls: "habits-compact-header" });
		const stats = this.button(header, this.stats ? "home" : "chart-column", this.stats ? t("Back to habits") : t("View stats"), () => {
			this.stats = !this.stats;
			this.render();
		});
		stats.setAttribute("aria-pressed", String(this.stats));
		const nav = header.createDiv({ cls: "habits-compact-nav" });
		this.button(nav, "chevron-left", t("Previous day"), () => { this.selectedDate = addDays(this.selectedDate, -1); this.render(); });
		const today = nav.createEl("button", { cls: "habits-compact-date", text: friendlyDateLabel(this.selectedDate, new Date()), attr: { type: "button", "aria-label": t("Today") } });
		this.renderEvents.registerDomEvent(today, "click", () => { this.selectedDate = new Date(); this.render(); });
		this.button(nav, "chevron-right", t("Next day"), () => { this.selectedDate = addDays(this.selectedDate, 1); this.render(); });
		this.button(header, "plus", t("Add habit"), () => {
			new HabitModal(this.app, this.store, () => this.render(), null, settings.experimental.limitHabits, settings.experimental.noteHabits).open();
		});
		if (this.stats) {
			renderStatsView(root.createDiv(), habits, "weekly", "calendar", this.selectedDate, undefined, undefined, undefined, settings.groups);
			return;
		}
		const due = habits.filter(h => isActive(h, this.selectedDate) && (!h.startDate || toDateKey(this.selectedDate) >= h.startDate));
		if (!due.length) {
			root.createDiv({ cls: "habits-compact-empty", text: habits.length ? t("Nothing due today.") : t("No habits yet.") });
			return;
		}
		const list = root.createDiv({ cls: "habits-compact-list" });
		const grouped = settings.groupsEnabled && settings.sortMode === "group";
		for (const section of groupHabits(due, grouped, settings.groupOrder)) {
			if (grouped) list.createDiv({ cls: "habits-compact-group", text: sectionLabel(section.key) });
			// Keep rows in their chosen order while logging, so controls never jump under the pointer.
			for (const habit of section.habits) this.renderRow(list, habit);
		}
	}

	private renderRow(list: HTMLElement, habit: HabitDefinition): void {
		const key = toDateKey(this.selectedDate);
		const row = list.createDiv({ cls: "habits-compact-row" });
		row.setCssProps({ "--habits-accent": habitAccent(habit, this.getSettings().groups) || "var(--interactive-accent)" });
		row.toggleClass("is-done", isComplete(habit, key));
		const name = row.createEl("a", { cls: "habits-compact-name", href: habit.path });
		if (habit.icon) applyHabitIcon(name.createSpan({ cls: "habits-compact-icon" }), habit.icon);
		name.createSpan({ text: habit.name });
		this.renderEvents?.registerDomEvent(name, "click", evt => { evt.preventDefault(); void this.app.workspace.openLinkText(habit.path, this.sourcePath, false); });
		const controls = row.createDiv({ cls: "habits-compact-controls" });
		if (isPausedOn(habit, key)) { controls.createSpan({ text: t("Paused") }); return; }
		if (habit.type === "note") {
			const path = notePathForDate(habit, key);
			const exists = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
			this.button(controls, exists ? "file-text" : "square-pen", exists ? t("Open this day's note") : t("Write this day's note"), () => {
				void (async () => {
					if (exists) await this.app.workspace.openLinkText(path, this.sourcePath, false);
					else { const file = await createNoteHabitEntry(this.app, habit, key); if (file) await this.app.workspace.openLinkText(file.path, this.sourcePath, false); }
				})();
			});
			return;
		}
		const value = habit.records[key] ?? 0;
		const busy = this.pending.has(habit.path);
		if (habit.type === "binary" && !isFlexible(habit)) {
			const active = value >= 1;
			const limit = habit.goalDirection === "max";
			const toggle = this.button(controls, active ? (limit ? "x" : "check") : "circle", limit ? (active ? t("Mark as clean") : t("Mark as slipped")) : (active ? t("Mark as not done") : t("Mark as done")), () => { void this.commit(habit, key, active ? 0 : 1); });
			toggle.addClass("habits-compact-toggle");
			toggle.setAttribute("aria-pressed", String(active));
			toggle.disabled = busy;
			return;
		}
		const flexible = isFlexible(habit);
		const total = flexible ? flexiblePeriodTotal(habit, this.selectedDate) : value;
		const target = habit.goalDirection === "max" ? limitOf(habit) : habit.target;
		const readout = controls.createSpan({ cls: "habits-compact-value" });
		readout.createSpan({ cls: "habits-compact-current", text: String(total) });
		readout.createSpan({ text: ` / ${target}${habit.unit ? ` ${habit.unit}` : ""}${flexible ? ` ${habit.frequency === "flexibleWeekly" ? t("This week") : t("This month")}` : ""}` });
		const step = habit.type === "timed" ? 5 : 1;
		const minus = this.button(controls, "minus", t("Decrease by {n}", { n: step }), () => { void this.commit(habit, key, Math.max(0, value - step)); });
		minus.disabled = busy || value <= 0;
		const plus = this.button(controls, "plus", t("Increase by {n}", { n: step }), () => { void this.commit(habit, key, value + step); });
		plus.disabled = busy;
	}

	private async commit(habit: HabitDefinition, key: string, value: number): Promise<void> {
		if (this.pending.has(habit.path)) return;
		this.pending.add(habit.path);
		this.render();
		try {
			await this.store.setRecord(habit, key, value);
			const saved = this.savedValues.get(habit.path) ?? new Map<string, number>();
			saved.set(key, value);
			this.savedValues.set(habit.path, saved);
		} catch {
			new Notice(t("Could not save habit record."));
		} finally {
			this.pending.delete(habit.path);
			this.render();
		}
	}
}

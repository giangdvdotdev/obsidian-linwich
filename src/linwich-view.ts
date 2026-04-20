import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import { getAllVocabWords } from './vocab';
import { GrammarCheckResult } from './grammar-check';
import type LinwichPlugin from './main';

export const LINWICH_VIEW_TYPE = 'linwich';

type Tab = 'vocab' | 'mistakes';

// ── Mistake helpers ───────────────────────────────────────────────────────────

interface MistakeEntry {
	source_file: string;
	original: string;
	correction: string;
	explanation: string;
	line: number;
	timestamp: string;
	dismissed: boolean;
	filePath: string;
}

function getAllMistakes(app: import('obsidian').App, root: string): MistakeEntry[] {
	const folder = app.vault.getFolderByPath(`${root}/Mistakes`);
	if (!folder) return [];
	const entries: MistakeEntry[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		const cache = app.metadataCache.getFileCache(child);
		const fm = cache?.frontmatter;
		if (!fm) continue;
		entries.push({
			source_file: fm['source_file'] ?? '',
			original:    fm['original']    ?? '',
			correction:  fm['correction']  ?? '',
			explanation: fm['explanation'] ?? '',
			line:        fm['line']        ?? 0,
			timestamp:   fm['timestamp']   ?? '',
			dismissed:   fm['dismissed']   === true,
			filePath:    child.path,
		});
	}
	entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return entries;
}

async function dismissMistake(app: import('obsidian').App, filePath: string): Promise<void> {
	const file = app.vault.getFileByPath(filePath);
	if (!file) return;
	const content = await app.vault.read(file);
	let updated: string;
	if (/^dismissed:\s*(false|true)/m.test(content)) {
		updated = content.replace(/^dismissed:\s*(false|true)/m, 'dismissed: true');
	} else {
		updated = content.replace(/^(---\n[\s\S]*?)\n---/m, '$1\ndismissed: true\n---');
	}
	await app.vault.modify(file, updated);
}

// ── Combined view ─────────────────────────────────────────────────────────────

export class LinwichView extends ItemView {
	private plugin: LinwichPlugin;
	private activeTab: Tab = 'vocab';
	private vocabSearch = '';
	private showDismissed = false;
	private grammarChecking = false;
	private grammarCheckResult: GrammarCheckResult | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: LinwichPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType():    string { return LINWICH_VIEW_TYPE; }
	getDisplayText(): string { return 'Linwich'; }
	getIcon():        string { return 'linwich-icon'; }

	setCheckResult(result: GrammarCheckResult): void {
		this.grammarCheckResult = result;
		this.activeTab = 'mistakes';
	}

	async onOpen(): Promise<void> {
		const root = this.plugin.settings.linwichFolder;

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const p = file.path;
				if (
					(this.activeTab === 'vocab'    && p.startsWith(`${root}/Vocab/`))    ||
					(this.activeTab === 'mistakes' && p.startsWith(`${root}/Mistakes/`))
				) {
					void this.render();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				const p = file.path;
				if (p.startsWith(`${root}/Vocab/`) || p.startsWith(`${root}/Mistakes/`)) {
					void this.render();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				// Suppress re-render during active grammar check; view is refreshed manually after check
				if (file.path.startsWith(`${root}/Mistakes/`) && !this.grammarChecking) void this.render();
			})
		);

		await this.render();
	}

	onClose(): Promise<void> { return Promise.resolve(); }

	// ── Top-level render ───────────────────────────────────────────────────────

	async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('linwich-view');

		// Icon toolbar (mirrors Git plugin style)
		const tabBar = container.createEl('div', { cls: 'linwich-tab-bar' });

		const vocabBtn    = tabBar.createEl('button', { cls: 'linwich-tab-btn clickable-icon' });
		const mistakesBtn = tabBar.createEl('button', { cls: 'linwich-tab-btn clickable-icon' });
		setIcon(vocabBtn,    'notebook');
		setIcon(mistakesBtn, 'scan-search');
		setTooltip(vocabBtn,    'Vocab');
		setTooltip(mistakesBtn, 'Mistakes');

		const setActive = (tab: Tab) => {
			this.activeTab = tab;
			vocabBtn.toggleClass('is-active',    tab === 'vocab');
			mistakesBtn.toggleClass('is-active', tab === 'mistakes');
			vocabSection.toggleClass('is-hidden',    tab !== 'vocab');
			mistakesSection.toggleClass('is-hidden', tab !== 'mistakes');
		};

		vocabBtn.addEventListener('click',    () => setActive('vocab'));
		mistakesBtn.addEventListener('click', () => setActive('mistakes'));

		// Content sections
		const vocabSection    = container.createEl('div', { cls: 'linwich-section' });
		const mistakesSection = container.createEl('div', { cls: 'linwich-section' });

		await this.renderVocab(vocabSection);
		await this.renderMistakesTab(mistakesSection);

		// Apply active tab state (restores after re-render)
		setActive(this.activeTab);
	}

	// ── Vocab section ──────────────────────────────────────────────────────────

	private async renderVocab(section: HTMLElement): Promise<void> {
		const root = this.plugin.settings.linwichFolder;

		const searchEl = section.createEl('input', {
			type: 'text',
			placeholder: 'Search words…',
			cls: 'linwich-search',
		});
		searchEl.value = this.vocabSearch;
		const listEl = section.createEl('div', { cls: 'linwich-vocab-list' });
		const allEntries = getAllVocabWords(this.app, root);

		searchEl.addEventListener('input', () => {
			this.vocabSearch = searchEl.value;
			this.renderVocabList(listEl, allEntries);
		});

		this.renderVocabList(listEl, allEntries);
	}

	private renderVocabList(
		listEl: HTMLElement,
		allEntries: Awaited<ReturnType<typeof getAllVocabWords>>
	): void {
		listEl.empty();
		const query = this.vocabSearch.toLowerCase();

		const filtered = query
			? allEntries.filter(e =>
				e.word.toLowerCase().includes(query) ||
				e.definition.toLowerCase().includes(query)
			)
			: allEntries;

		for (const entry of filtered) {
			const item  = listEl.createEl('div', { cls: 'linwich-vocab-item' });
			item.createEl('div', { text: entry.word,       cls: 'linwich-vocab-word' });
			item.createEl('div', { text: entry.definition, cls: 'linwich-vocab-def' });
			item.addEventListener('click', () => {
				void this.app.workspace.openLinkText(entry.filePath, '', false);
			});
		}

		if (filtered.length === 0) {
			listEl.createEl('div', { text: 'No words found.', cls: 'linwich-empty' });
		}
	}

	// ── Mistakes tab ──────────────────────────────────────────────────────────

	private async renderMistakesTab(section: HTMLElement): Promise<void> {
		const root = this.plugin.settings.linwichFolder;

		// Check result (shown above the list, persists across re-renders)
		const resultEl = section.createEl('div', { cls: 'linwich-check-result' });
		if (this.grammarCheckResult) {
			this.renderCheckResult(resultEl, this.grammarCheckResult);
		}

		// Mistakes header + dismiss toggle
		const mistakesHeader = section.createEl('div', { cls: 'linwich-mistakes-header' });
		mistakesHeader.createEl('h6', { text: 'Mistakes', cls: 'linwich-section-heading' });

		const toggleLabel = mistakesHeader.createEl('label', { cls: 'linwich-toggle-label' });
		const toggleInput = toggleLabel.createEl('input', { type: 'checkbox' });
		toggleInput.checked = this.showDismissed;
		toggleLabel.createEl('span', { text: 'Show dismissed' });

		const mistakesEl  = section.createEl('div', { cls: 'linwich-mistakes-list' });
		const allMistakes = getAllMistakes(this.app, root);

		const refreshMistakes = () => {
			mistakesEl.empty();
			const visible = this.showDismissed
				? allMistakes
				: allMistakes.filter(m => !m.dismissed);
			this.renderMistakes(mistakesEl, visible);
		};

		toggleInput.addEventListener('change', () => {
			this.showDismissed = toggleInput.checked;
			refreshMistakes();
		});

		refreshMistakes();
	}

	private renderMistakes(container: HTMLElement, mistakes: MistakeEntry[]): void {
		if (mistakes.length === 0) {
			container.createEl('div', { text: 'No mistakes recorded.', cls: 'linwich-empty' });
			return;
		}
		for (const m of mistakes) {
			const card = container.createEl('div', {
				cls: `linwich-mistake-card${m.dismissed ? ' is-dismissed' : ''}`,
			});

			const sourceEl   = card.createEl('div', { cls: 'linwich-mistake-source' });
			const sourceLink = sourceEl.createEl('a', {
				text: m.source_file,
				cls: 'linwich-mistake-source-link',
			});
			sourceLink.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.app.workspace.openLinkText(m.source_file, '', false);
			});
			if (m.line) {
				sourceEl.createEl('span', { text: ` :${m.line}`, cls: 'linwich-mistake-line' });
			}

			const diffEl = card.createEl('div', { cls: 'linwich-mistake-diff' });
			diffEl.createEl('span', { text: m.original,   cls: 'linwich-mistake-original' });
			diffEl.createEl('span', { text: ' → ',        cls: 'linwich-mistake-arrow' });
			diffEl.createEl('span', { text: m.correction, cls: 'linwich-mistake-correction' });

			card.createEl('div', { text: m.explanation, cls: 'linwich-mistake-explanation' });

			if (!m.dismissed) {
				const btn = card.createEl('button', { text: 'Dismiss', cls: 'linwich-dismiss-btn' });
				btn.addEventListener('click', (e) => {
					e.stopPropagation();
					void dismissMistake(this.app, m.filePath);
				});
			}
		}
	}

	// ── Check result renderer (10.9) ──────────────────────────────────────────

	private renderCheckResult(el: HTMLElement, result: GrammarCheckResult): void {
		el.empty();
		switch (result.type) {
			case 'ok':
				el.createEl('span', {
					text: `Found ${result.count} mistake${result.count !== 1 ? 's' : ''} in ${result.filename}`,
					cls: 'linwich-check-info',
				});
				break;
			case 'none':
				el.createEl('span', {
					text: `No mistakes found in ${result.filename}`,
					cls: 'linwich-check-ok',
				});
				break;
			case 'nofile':
				el.createEl('span', {
					text: 'No Markdown file is active.',
					cls: 'linwich-check-warn',
				});
				break;
			case 'toolarge':
				el.createEl('span', {
					text: 'File too large (max 10 KB).',
					cls: 'linwich-check-warn',
				});
				break;
			case 'nokey': {
				el.createEl('span', { text: 'API key not set. ', cls: 'linwich-check-warn' });
				const link = el.createEl('a', { text: 'Open settings', cls: 'linwich-check-settings-link' });
				link.addEventListener('click', () => {
					const appSettings = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
					appSettings?.open?.();
					appSettings?.openTabById?.('linwich');
				});
				break;
			}
			case 'error':
				el.createEl('span', {
					text: `Check failed: ${result.message}`,
					cls: 'linwich-check-error',
				});
				break;
		}
	}

}

import { ItemView, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { getAllVocabWords } from './vocab';
import type LinwichPlugin from './main';

export const VOCAB_VIEW_TYPE = 'linwich-vocab';

export class VocabView extends ItemView {
	private plugin: LinwichPlugin;
	private searchQuery = '';

	constructor(leaf: WorkspaceLeaf, plugin: LinwichPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VOCAB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Vocab';
	}

	getIcon(): string {
		return 'book-open';
	}

	async onOpen(): Promise<void> {
		const vocabPath = `${this.plugin.settings.linwichFolder}/Vocab/`;

		// Re-render after metadata cache has parsed the file (frontmatter is ready)
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file.path.startsWith(vocabPath)) void this.render();
			})
		);
		// Deletions don't trigger metadataCache 'changed', use vault event for those
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file.path.startsWith(vocabPath)) void this.render();
			})
		);

		this.render();
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}

	render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('linwich-vocab-view');

		// Search input
		const searchEl = container.createEl('input', {
			type: 'text',
			placeholder: 'Search words…',
			cls: 'linwich-search',
		});
		searchEl.value = this.searchQuery;
		searchEl.addEventListener('input', () => {
			this.searchQuery = searchEl.value;
			this.renderList(listEl, allEntries);
		});

		const listEl = container.createEl('div', { cls: 'linwich-vocab-list' });

		const root = this.plugin.settings.linwichFolder;
		const allEntries = getAllVocabWords(this.app, root);
		this.renderList(listEl, allEntries);
	}

	private renderList(
		listEl: HTMLElement,
		allEntries: Awaited<ReturnType<typeof getAllVocabWords>>
	): void {
		listEl.empty();
		const query = this.searchQuery.toLowerCase();

		const filtered = query
			? allEntries.filter(
					e =>
						e.word.toLowerCase().includes(query) ||
						e.definition.toLowerCase().includes(query)
			  )
			: allEntries;

		for (const entry of filtered) {
			const item = listEl.createEl('div', { cls: 'linwich-vocab-item' });
			item.createEl('div', { text: entry.word, cls: 'linwich-vocab-word' });
			item.createEl('div', { text: entry.definition, cls: 'linwich-vocab-def' });

			item.addEventListener('click', () => {
				void this.app.workspace.openLinkText(entry.filePath, '', false);
			});
		}

		if (filtered.length === 0) {
			listEl.createEl('div', { text: 'No words found.', cls: 'linwich-empty' });
		}
	}
}

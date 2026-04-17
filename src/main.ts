import { Editor, MarkdownView, Notice, Plugin, TAbstractFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, LinwichSettings, LinwichSettingTab } from './settings';
import { AddVocabModal } from './add-vocab-modal';
import { getVocabNoteSync } from './vocab';
import { VocabWordCache, makeVocabViewPlugin, registerReadingViewProcessor, vocabCacheUpdated } from './vocab-hover';
import { LINWICH_VIEW_TYPE, LinwichView } from './linwich-view';
import { runGrammarCheck } from './grammar-check';

export default class LinwichPlugin extends Plugin {
	settings!: LinwichSettings;
	vocabCache!: VocabWordCache;
	lastMarkdownFile: import('obsidian').TFile | null = null;

	async onload() {
		await this.loadSettings();
		await this.ensureFolders();

		// 7.1 — build word set cache
		this.vocabCache = new VocabWordCache(this.app, this.settings.linwichFolder);
		await this.vocabCache.refresh();

		// 7.2 — refresh cache once metadata is ready (frontmatter parsed), then signal editors
		const refreshAndSignal = async () => {
			await this.vocabCache.refresh();
			this.app.workspace.iterateAllLeaves(leaf => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const cm = (leaf.view as any)?.editor?.cm as (EditorView | undefined);
				if (cm) cm.dispatch({ effects: vocabCacheUpdated.of() });
			});
		};

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file.path.startsWith(`${this.settings.linwichFolder}/Vocab/`)) {
					refreshAndSignal();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file.path.startsWith(`${this.settings.linwichFolder}/Vocab/`)) {
					refreshAndSignal();
				}
			})
		);

		// 7.3 — CM6 ViewPlugin for Live Preview
		this.registerEditorExtension(
			makeVocabViewPlugin(this.vocabCache, this.app, this.settings.linwichFolder)
		);

		// 7.5 — MarkdownPostProcessor for Reading View
		registerReadingViewProcessor(
			this.app,
			this.settings.linwichFolder,
			this.vocabCache,
			fn => this.registerMarkdownPostProcessor(fn)
		);

		// Track the last focused markdown file so grammar check works when sidebar is active
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file) {
					this.lastMarkdownFile = view.file;
				}
			})
		);

		this.registerView(LINWICH_VIEW_TYPE, leaf => new LinwichView(leaf, this));

		this.addRibbonIcon('languages', 'Linwich', () => {
			this.activateLinwichView();
		});

		this.addCommand({
			id: 'open-linwich-view',
			name: 'Open Linwich sidebar',
			callback: () => this.activateLinwichView(),
		});

		// 10.11 — Command palette entry for grammar check
		this.addCommand({
			id: 'check-grammar',
			name: 'Check grammar',
			callback: async () => {
				const result = await runGrammarCheck(this.app, this.settings, this.lastMarkdownFile);
				switch (result.type) {
					case 'ok':
						new Notice(`Found ${result.count} mistake${result.count !== 1 ? 's' : ''} in ${result.filename}`);
						break;
					case 'none':
						new Notice(`No mistakes found in ${result.filename}`);
						break;
					case 'nofile':
						new Notice('No Markdown file is active.');
						break;
					case 'toolarge':
						new Notice('File too large (max 10 KB).');
						break;
					case 'nokey':
						new Notice('Claude API key not set. Add it in Linwich settings.');
						break;
					case 'error':
						new Notice(`Grammar check failed: ${result.message}`);
						break;
				}
			},
		});

		this.registerEvent(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.workspace as any).on('editor-menu', (menu: any, editor: Editor, _view: MarkdownView) => {
				const root = this.settings.linwichFolder;

				// Always available: check grammar on the active file
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				menu.addItem((item: any) =>
					item
						.setTitle('Check grammar')
						.setIcon('spell-check')
						.onClick(async () => {
							const result = await runGrammarCheck(this.app, this.settings, this.lastMarkdownFile);
							const view = this.getLinwichView();
							if (view) {
								view.setCheckResult(result);
								await view.render();
							}
						})
				);

				// Single-word selection: add/edit vocab
				const selection = editor.getSelection().trim();
				if (!selection || selection.includes(' ')) return;

				const file = getVocabNoteSync(this.app, root, selection);
				if (file) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					menu.addItem((item: any) =>
						item
							.setTitle(`Edit '${selection}' in Vocab`)
							.setIcon('pencil')
							.onClick(() => {
								this.app.workspace.openLinkText(file.path, '', false);
							})
					);
				} else {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					menu.addItem((item: any) =>
						item
							.setTitle(`Add '${selection}' to Vocab`)
							.setIcon('plus-circle')
							.onClick(() => {
								const sourcePath = _view.file?.path;
								new AddVocabModal(this.app, root, selection, sourcePath).open();
							})
					);
				}
			})
		);

		this.addSettingTab(new LinwichSettingTab(this.app, this));
	}

	onunload() {
		// Clean up plugin resources
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LinwichSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getLinwichView(): LinwichView | null {
		const leaf = this.app.workspace.getLeavesOfType(LINWICH_VIEW_TYPE)[0];
		return leaf?.view instanceof LinwichView ? leaf.view : null;
	}

	async activateLinwichView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(LINWICH_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: LINWICH_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async ensureFolders() {
		const root = this.settings.linwichFolder;
		const subfolders = ['Vocab', 'Mistakes'];
		for (const sub of subfolders) {
			const path = `${root}/${sub}`;
			if (!(await this.app.vault.adapter.exists(path))) {
				await this.app.vault.createFolder(path);
			}
		}
	}
}

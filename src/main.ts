import { Editor, EventRef, MarkdownView, Menu, MenuItem, Notice, Plugin, TAbstractFile, Workspace, addIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, LinwichSettings, LinwichSettingTab } from './settings';
import { AddVocabModal } from './add-vocab-modal';
import { getVocabNoteSync } from './vocab';
import { VocabWordCache, makeVocabViewPlugin, registerReadingViewProcessor, vocabCacheUpdated } from './vocab-hover';
import { LINWICH_VIEW_TYPE, LinwichView } from './linwich-view';
import { runGrammarCheck } from './grammar-check';
import { LINWICH_ICON_SVG } from './icon';

export default class LinwichPlugin extends Plugin {
	settings!: LinwichSettings;
	vocabCache!: VocabWordCache;
	lastMarkdownFile: import('obsidian').TFile | null = null;

	async onload() {
		await this.loadSettings();
		await this.ensureFolders();

		// 7.1 — build word set cache
		this.vocabCache = new VocabWordCache(this.app, this.settings.linwichFolder);
		this.vocabCache.refresh();

		// 7.2 — refresh cache once metadata is ready (frontmatter parsed), then signal editors
		const refreshAndSignal = () => {
			this.vocabCache.refresh();
			this.app.workspace.iterateAllLeaves(leaf => {
				const cm = (leaf.view as unknown as { editor?: { cm?: EditorView } }).editor?.cm;
				if (cm) cm.dispatch({ effects: vocabCacheUpdated.of() });
			});
		};

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file.path.startsWith(`${this.settings.linwichFolder}/Vocab/`)) {
					void refreshAndSignal();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file.path.startsWith(`${this.settings.linwichFolder}/Vocab/`)) {
					void refreshAndSignal();
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

		addIcon('linwich-icon', LINWICH_ICON_SVG);

		this.registerView(LINWICH_VIEW_TYPE, leaf => new LinwichView(leaf, this));

		this.addRibbonIcon('linwich-icon', 'Linwich', () => {
			void this.activateLinwichView();
		});

		this.addCommand({
			id: 'open-view',
			name: 'Open sidebar',
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
						new Notice('File too large (max 10 kb).');
						break;
					case 'nokey':
						new Notice('Claude API key not set. Open plugin settings to add it.');
						break;
					case 'error':
						new Notice(`Grammar check failed: ${result.message}`);
						break;
				}
			},
		});

		type WorkspaceWithEditorMenu = Workspace & {
			on(name: 'editor-menu', callback: (menu: Menu, editor: Editor, view: MarkdownView) => void): EventRef;
		};
		this.registerEvent(
			(this.app.workspace as WorkspaceWithEditorMenu).on('editor-menu', (menu: Menu, editor: Editor, _view: MarkdownView) => {
				const root = this.settings.linwichFolder;

				// Always available: check grammar on the active file
				menu.addItem((item: MenuItem) =>
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
					menu.addItem((item: MenuItem) =>
						item
							.setTitle(`Edit '${selection}' in Vocab`)
							.setIcon('pencil')
							.onClick(() => {
								void this.app.workspace.openLinkText(file.path, '', false);
							})
					);
				} else {
					menu.addItem((item: MenuItem) =>
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

	onunload() {}

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
		void workspace.revealLeaf(leaf);
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

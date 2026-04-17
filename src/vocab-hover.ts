import { App, MarkdownPostProcessorContext } from 'obsidian';
import { EditorView, ViewPlugin, Decoration, DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { getAllVocabWords } from './vocab';

// Dispatched to all open editors when the vocab cache is refreshed
export const vocabCacheUpdated = StateEffect.define<void>();

// ---------------------------------------------------------------------------
// Word set cache
// ---------------------------------------------------------------------------

export class VocabWordCache {
	private wordSet: Set<string> = new Set();
	private app: App;
	private root: string;

	constructor(app: App, root: string) {
		this.app = app;
		this.root = root;
	}

	async refresh(): Promise<void> {
		const entries = await getAllVocabWords(this.app, this.root);
		this.wordSet = new Set(entries.map(e => e.word.toLowerCase()));
	}

	has(word: string): boolean {
		return this.wordSet.has(word.toLowerCase());
	}

	get size(): number {
		return this.wordSet.size;
	}
}

// ---------------------------------------------------------------------------
// Hover popup
// ---------------------------------------------------------------------------

function showVocabPopup(app: App, root: string, word: string, x: number, y: number): HTMLElement | null {
	const path = `${root}/Vocab/${word.toLowerCase()}.md`;
	const file = app.vault.getFileByPath(path);
	if (!file) return null;

	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm) return null;

	const popup = document.createElement('div');
	popup.className = 'linwich-hover-card';
	popup.style.setProperty('--linwich-popup-x', `${x}px`);
	popup.style.setProperty('--linwich-popup-y', `${y + 20}px`);

	const wordEl = popup.createEl('div', { cls: 'linwich-hover-card-word', text: fm['word'] ?? word });
	const defEl = popup.createEl('div', { cls: 'linwich-hover-card-definition', text: fm['definition'] ?? '' });
	if (fm['example']) {
		popup.createEl('div', { cls: 'linwich-hover-card-example', text: fm['example'] });
	}
	// suppress unused variable warnings
	void wordEl; void defEl;

	document.body.appendChild(popup);
	return popup;
}

function removePopup(popup: HTMLElement | null): void {
	popup?.remove();
}

// ---------------------------------------------------------------------------
// CodeMirror 6 ViewPlugin (Live Preview)
// ---------------------------------------------------------------------------

const vocabMark = Decoration.mark({ class: 'linwich-vocab-token' });

function buildDecorations(view: EditorView, cache: VocabWordCache): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const wordRe = /[A-Za-z]+/g;

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.sliceDoc(from, to);
		let m: RegExpExecArray | null;
		wordRe.lastIndex = 0;
		while ((m = wordRe.exec(text)) !== null) {
			const word = m[0].toLowerCase();
			if (cache.has(word)) {
				builder.add(from + m.index, from + m.index + m[0].length, vocabMark);
			}
		}
	}
	return builder.finish();
}

export function makeVocabViewPlugin(cache: VocabWordCache, app: App, root: string) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private debounceTimer: ReturnType<typeof setTimeout> | null = null;
			private activePopup: HTMLElement | null = null;
			private dom: HTMLElement | null = null;
			private mouseoverHandler: ((e: MouseEvent) => void) | null = null;
			private mouseoutHandler:  ((e: MouseEvent) => void) | null = null;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, cache);
				this.attachMouseHandlers(view);
			}

			update(update: ViewUpdate) {
				const cacheChanged = update.transactions.some(tr =>
					tr.effects.some(e => e.is(vocabCacheUpdated))
				);
				if (update.docChanged || update.viewportChanged || cacheChanged) {
					if (this.debounceTimer) clearTimeout(this.debounceTimer);
					const delay = cacheChanged ? 0 : 200;
					this.debounceTimer = setTimeout(() => {
						this.decorations = buildDecorations(update.view, cache);
					}, delay);
				}
			}

			destroy() {
				if (this.debounceTimer) clearTimeout(this.debounceTimer);
				if (this.mouseoverHandler) this.dom?.removeEventListener('mouseover', this.mouseoverHandler);
				if (this.mouseoutHandler)  this.dom?.removeEventListener('mouseout',  this.mouseoutHandler);
				removePopup(this.activePopup);
			}

			private attachMouseHandlers(view: EditorView) {
				this.dom = view.dom;

				this.mouseoverHandler = (e: MouseEvent) => {
					const target = e.target as HTMLElement;
					if (!target.classList.contains('linwich-vocab-token')) {
						removePopup(this.activePopup);
						this.activePopup = null;
						return;
					}
					const word = target.textContent ?? '';
					removePopup(this.activePopup);
					this.activePopup = showVocabPopup(app, root, word, e.pageX, e.pageY);
				};

				this.mouseoutHandler = (e: MouseEvent) => {
					const related = e.relatedTarget as HTMLElement | null;
					if (!related?.classList.contains('linwich-hover-card')) {
						removePopup(this.activePopup);
						this.activePopup = null;
					}
				};

				this.dom.addEventListener('mouseover', this.mouseoverHandler);
				this.dom.addEventListener('mouseout',  this.mouseoutHandler);
			}
		},
		{ decorations: v => v.decorations }
	);
}

// ---------------------------------------------------------------------------
// Reading View post-processor
// ---------------------------------------------------------------------------

export function registerReadingViewProcessor(
	app: App,
	root: string,
	cache: VocabWordCache,
	registerMarkdownPostProcessor: (fn: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void
): void {
	registerMarkdownPostProcessor((el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
		if (cache.size === 0) return;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			textNodes.push(node as Text);
		}

		for (const textNode of textNodes) {
			const text = textNode.textContent ?? '';
			const wordRe = /[A-Za-z]+/g;
			let lastIndex = 0;
			const parts: (string | HTMLElement)[] = [];
			let m: RegExpExecArray | null;

			while ((m = wordRe.exec(text)) !== null) {
				if (cache.has(m[0])) {
					if (m.index > lastIndex) {
						parts.push(text.slice(lastIndex, m.index));
					}
					const span = document.createElement('span');
					span.className = 'linwich-vocab-token';
					span.textContent = m[0];

					let activePopup: HTMLElement | null = null;
					span.addEventListener('mouseenter', (e: MouseEvent) => {
						activePopup = showVocabPopup(app, root, m![0], e.pageX, e.pageY);
					});
					span.addEventListener('mouseleave', () => {
						removePopup(activePopup);
						activePopup = null;
					});

					parts.push(span);
					lastIndex = m.index + m[0].length;
				}
			}

			if (parts.length > 0) {
				if (lastIndex < text.length) parts.push(text.slice(lastIndex));
				const frag = document.createDocumentFragment();
				for (const part of parts) {
					if (typeof part === 'string') {
						frag.appendChild(document.createTextNode(part));
					} else {
						frag.appendChild(part);
					}
				}
				textNode.parentNode?.replaceChild(frag, textNode);
			}
		}
	});
}

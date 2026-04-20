import { App, TFile } from 'obsidian';

export interface VocabEntry {
	word: string;
	definition: string;
	example: string;
	added: string;
	tags: string[];
	filePath: string;
}

function vocabPath(root: string, word: string): string {
	return `${root}/Vocab/${word.toLowerCase()}.md`;
}

function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function createVocabNote(
	app: App,
	root: string,
	word: string,
	definition: string,
	example: string,
	sourcePath?: string
): Promise<void> {
	const path = vocabPath(root, word);
	const lines = [
		'---',
		`word: ${word.toLowerCase()}`,
		`definition: ${definition}`,
		`example: ${example}`,
		`added: ${todayISO()}`,
		'tags: [vocab]',
	];
	if (sourcePath) {
		lines.push(`sources: ["${sourcePath}"]`);
	}
	lines.push('---');
	const content = lines.join('\n') + '\n';
	await app.vault.create(path, content);
}

export function getVocabNote(app: App, root: string, word: string): TFile | null {
	return getVocabNoteSync(app, root, word);
}

export function getVocabNoteSync(app: App, root: string, word: string): TFile | null {
	const path = vocabPath(root, word);
	const file = app.vault.getFileByPath(path);
	return file ?? null;
}

export function getAllVocabWords(app: App, root: string): VocabEntry[] {
	const folder = app.vault.getFolderByPath(`${root}/Vocab`);
	if (!folder) return [];

	const entries: VocabEntry[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		const cache = app.metadataCache.getFileCache(child);
		const fm = cache?.frontmatter;
		if (!fm) continue;
		entries.push({
			word: fm['word'] ?? child.basename,
			definition: fm['definition'] ?? '',
			example: fm['example'] ?? '',
			added: fm['added'] ?? '',
			tags: fm['tags'] ?? ['vocab'],
			filePath: child.path,
		});
	}

	entries.sort((a, b) => a.added.localeCompare(b.added));
	return entries;
}

export function getBacklinksForVocab(
	app: App,
	root: string,
	word: string
): string[] {
	const targetPath = vocabPath(root, word);
	const file = app.vault.getFileByPath(targetPath);
	if (!file) return [];
	const cache = app.metadataCache.getFileCache(file);
	const sources = cache?.frontmatter?.['sources'];
	if (!Array.isArray(sources)) return [];
	return sources;
}

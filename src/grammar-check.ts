import { App, MarkdownView, TFile, requestUrl } from 'obsidian';
import type { LinwichSettings } from './settings';

export interface GrammarMistake {
	original: string;
	correction: string;
	explanation: string;
	line: number;
}

export type GrammarCheckResult =
	| { type: 'ok'; count: number; filename: string }
	| { type: 'none'; filename: string }
	| { type: 'error'; message: string }
	| { type: 'nofile' }
	| { type: 'toolarge' }
	| { type: 'nokey' };

// 10.6 — Call Claude API with grammar-check prompt
async function callClaudeApi(content: string, apiKey: string): Promise<GrammarMistake[]> {
	const response = await requestUrl({
		url: 'https://api.anthropic.com/v1/messages',
		method: 'POST',
		headers: {
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 1024,
			system:
				'You are an English grammar checker. Given markdown text, identify grammar mistakes. ' +
				'Return ONLY a JSON array of objects with fields: ' +
				'"original" (the incorrect phrase as it appears in the text), ' +
				'"correction" (the corrected version), ' +
				'"explanation" (brief reason, ≤20 words), ' +
				'"line" (1-based line number in the input). ' +
				'Return [] if no mistakes. Return ONLY valid JSON — no markdown fences, no explanation outside the array.',
			messages: [{ role: 'user', content }],
		}),
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`API error ${response.status}: ${String(response.text).slice(0, 200)}`);
	}

	const data = response.json as { content?: Array<{ type: string; text: string }> };
	let raw = data.content?.find(b => b.type === 'text')?.text ?? '[]';
	// Strip markdown code fences if the model wraps the JSON anyway
	raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
	return JSON.parse(raw) as GrammarMistake[];
}

// 10.7 — Check if a matching mistake note already exists
async function isDuplicate(
	app: App,
	root: string,
	sourceFile: string,
	line: number,
	original: string
): Promise<boolean> {
	const folder = app.vault.getFolderByPath(`${root}/Mistakes`);
	if (!folder) return false;

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		const fm = app.metadataCache.getFileCache(child)?.frontmatter;
		if (!fm) continue;
		if (fm['source_file'] === sourceFile && fm['line'] === line && fm['original'] === original) {
			return true;
		}
	}
	return false;
}

// 10.8 — Write a single Mistake note
async function writeMistakeNote(
	app: App,
	root: string,
	sourceFile: string,
	mistake: GrammarMistake,
	index: number
): Promise<void> {
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const sourceSlug = sourceFile
		.replace(/\.md$/, '')
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	const filename = `${date}-${sourceSlug}-${index}.md`;
	const path = `${root}/Mistakes/${filename}`;

	const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

	const content =
		`---\n` +
		`source_file: "${esc(sourceFile)}"\n` +
		`timestamp: "${now.toISOString()}"\n` +
		`original: "${esc(mistake.original)}"\n` +
		`correction: "${esc(mistake.correction)}"\n` +
		`explanation: "${esc(mistake.explanation)}"\n` +
		`line: ${mistake.line}\n` +
		`dismissed: false\n` +
		`tags:\n` +
		`  - mistake\n` +
		`---\n`;

	await app.vault.create(path, content);
}

// 10.4–10.9 — Main grammar check orchestrator
export async function runGrammarCheck(
	app: App,
	settings: LinwichSettings,
	// Fallback for when the sidebar has focus and getActiveViewOfType returns null
	fallbackFile?: TFile | null
): Promise<GrammarCheckResult> {
	// 10.4 — guard: no active MD file
	// getActiveViewOfType returns null when a sidebar panel (not a markdown editor) has focus,
	// so fall back to the last tracked markdown file
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	const file = activeView?.file ?? fallbackFile ?? null;
	if (!file) return { type: 'nofile' };
	const content = await app.vault.read(file);

	// 10.4 — guard: file >10KB
	if (new TextEncoder().encode(content).length > 10000) {
		return { type: 'toolarge' };
	}

	// 10.4 — guard: missing API key
	if (!settings.claudeApiKey) return { type: 'nokey' };

	try {
		const mistakes = await callClaudeApi(content, settings.claudeApiKey);

		if (mistakes.length === 0) {
			return { type: 'none', filename: file.path };
		}

		// 10.7 + 10.8 — deduplicate and write notes
		let written = 0;
		for (const mistake of mistakes) {
			const dup = await isDuplicate(app, settings.linwichFolder, file.path, mistake.line, mistake.original);
			if (!dup) {
				await writeMistakeNote(app, settings.linwichFolder, file.path, mistake, written + 1);
				written++;
			}
		}

		return { type: 'ok', count: written, filename: file.path };
	} catch (e) {
		return { type: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}

import { App, Modal, Setting } from 'obsidian';
import { createVocabNote } from './vocab';

export class AddVocabModal extends Modal {
	private word: string;
	private root: string;
	private definition = '';
	private example = '';
	private sourcePath?: string;

	constructor(app: App, root: string, word: string, sourcePath?: string) {
		super(app);
		this.root = root;
		this.word = word;
		this.sourcePath = sourcePath;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Add "${this.word}" to Vocab` });

		new Setting(contentEl)
			.setName('Word')
			.addText(text =>
				text.setValue(this.word).setDisabled(true)
			);

		new Setting(contentEl)
			.setName('Definition')
			.setDesc('Required')
			.addText(text => {
				text.setPlaceholder('Enter definition…').onChange(value => {
					this.definition = value;
				});
				text.inputEl.focus();
			});

		new Setting(contentEl)
			.setName('Example sentence')
			.setDesc('Optional')
			.addText(text =>
				text.setPlaceholder('Enter example sentence…').onChange(value => {
					this.example = value;
				})
			);

		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText('Save')
					.setCta()
					.onClick(async () => {
						if (!this.definition.trim()) return;
						await createVocabNote(
							this.app,
							this.root,
							this.word,
							this.definition.trim(),
							this.example.trim(),
							this.sourcePath
						);
						this.close();
					})
			)
			.addButton(btn =>
				btn.setButtonText('Cancel').onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

import { App, PluginSettingTab, Setting } from 'obsidian';
import LinwichPlugin from './main';

export interface LinwichSettings {
	linwichFolder: string;
	claudeApiKey: string;
}

export const DEFAULT_SETTINGS: LinwichSettings = {
	linwichFolder: 'linwich',
	claudeApiKey: '',
};

export class LinwichSettingTab extends PluginSettingTab {
	plugin: LinwichPlugin;

	constructor(app: App, plugin: LinwichPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Linwich folder')
			.setDesc('Root folder for vocab and mistakes notes (relative to vault root).')
			.addText(text =>
				text
					.setPlaceholder('Folder path')
					.setValue(this.plugin.settings.linwichFolder)
					.onChange(async value => {
						this.plugin.settings.linwichFolder = value.trim() || 'linwich';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Claude API key')
			.setDesc('Used for grammar checking. Get a key at console.anthropic.com.')
			.addText(text => {
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.claudeApiKey)
					.onChange(async value => {
						this.plugin.settings.claudeApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
	}
}

import browser from './browser-polyfill';
import { escapeDoubleQuotes, sanitizeFileName } from './string-utils';
import { Template, Property } from '../types/types';
import { generalSettings } from './storage-utils';
import { saveFile } from './file-utils';

export async function generateFrontmatter(properties: Property[]): Promise<string> {
	let frontmatter = '---\n';
	for (const property of properties) {
		// Wrap property name in quotes if it contains YAML-ambiguous characters
		const needsQuotes = /[:\s\{\}\[\],&*#?|<>=!%@\\-]/.test(property.name) || /^[\d]/.test(property.name) || /^(true|false|null|yes|no|on|off)$/i.test(property.name.trim());
		const propertyKey = needsQuotes ? (property.name.includes('"') ? `'${property.name.replace(/'/g, "''")}'` : `"${property.name}"`) : property.name;
		frontmatter += `${propertyKey}:`;

		const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

		switch (propertyType) {
			case 'multitext':
				let items: string[];
				if (property.value.trim().startsWith('["') && property.value.trim().endsWith('"]')) {
					try {
						items = JSON.parse(property.value);
					} catch (e) {
						// If parsing fails, fall back to splitting by comma
						items = property.value.split(',').map(item => item.trim());
					}
				} else {
					// Split by comma, but keep wikilinks intact
					items = property.value.split(/,(?![^\[]*\]\])/).map(item => item.trim());
				}
				items = items.filter(item => item !== '');
				if (items.length > 0) {
					frontmatter += '\n';
					items.forEach(item => {
						frontmatter += `  - "${escapeDoubleQuotes(item)}"\n`;
					});
				} else {
					frontmatter += '\n';
				}
				break;
			case 'number':
				const numericValue = property.value.replace(/[^\d.-]/g, '');
				frontmatter += numericValue ? ` ${parseFloat(numericValue)}\n` : '\n';
				break;
			case 'checkbox':
				const isChecked = typeof property.value === 'boolean' ? property.value : property.value === 'true';
				frontmatter += ` ${isChecked}\n`;
				break;
			case 'date':
			case 'datetime':
				if (property.value.trim() !== '') {
					frontmatter += ` ${property.value}\n`;
				} else {
					frontmatter += '\n';
				}
				break;
			default: // Text
				frontmatter += property.value.trim() !== '' ? ` "${escapeDoubleQuotes(property.value)}"\n` : '\n';
		}
	}
	frontmatter += '---\n';

	// Check if the frontmatter is empty
	if (frontmatter.trim() === '---\n---') {
		return '';
	}

	return frontmatter;
}

export async function saveNote(
	fileContent: string,
	noteName: string,
	path: string,
	behavior: Template['behavior'],
	tabId?: number
): Promise<void> {
	// Ensure path ends with a slash if provided
	if (path && !path.endsWith('/')) {
		path += '/';
	}

	const formattedNoteName = sanitizeFileName(noteName) || 'untitled';
	const fileName = `${path}${formattedNoteName}.md`;

	// Behaviors like append/prepend don't apply to a simple download.
	// We just save the file. Future implementation could use local storage if needed.

	await saveFile({
		content: fileContent,
		fileName,
		mimeType: 'text/markdown',
		tabId: tabId
	});
}


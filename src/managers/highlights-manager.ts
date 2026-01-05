import browser from '../utils/browser-polyfill';
import { detectBrowser } from '../utils/browser-detection';
import { AnyHighlightData } from '../utils/highlighter';
import dayjs from 'dayjs';
import { getMessage } from '../utils/i18n';

import { saveFile } from '../utils/file-utils';

export async function exportHighlights(): Promise<void> {
	try {
		const result = await browser.storage.local.get('highlights');
		const allHighlights = result.highlights || {};

		const exportData = Object.entries(allHighlights).map(([url, data]) => ({
			url,
			highlights: (data.highlights as AnyHighlightData[]).map(highlight => ({
				text: highlight.content,
				timestamp: dayjs(parseInt(highlight.id)).toISOString()
			}))
		}));

		const jsonContent = JSON.stringify(exportData, null, 2);
		const timestamp = dayjs().format('YYYYMMDDHHmm');
		const fileName = `highlights-${timestamp}.json`;

		await saveFile({
			content: jsonContent,
			fileName,
			mimeType: 'application/json',
			onError: (error) => {
				console.error('Error in saveFile during highlights export:', error);
				alert(getMessage('failedToExportHighlights'));
			}
		});
	} catch (error) {
		console.error('Error exporting highlights:', error);
		alert(getMessage('failedToExportHighlights'));
	}
}

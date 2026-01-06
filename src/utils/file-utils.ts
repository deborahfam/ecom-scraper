import browser from './browser-polyfill';
import { detectBrowser } from './browser-detection';

export interface SaveFileOptions {
	content: string;
	fileName: string;
	mimeType?: string;
	tabId?: number;
	onError?: (error: Error) => void;
}

export function base64EncodeUnicode(str: string): string {
	const utf8Bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, 
		(match, p1) => String.fromCharCode(parseInt(p1, 16))
	);
	return btoa(utf8Bytes);
}

/**
 * Converts an array of JSON objects to CSV format
 * @param jsonData Array of objects to convert
 * @returns CSV string
 */
export function jsonToCsv(jsonData: any[]): string {
	if (!jsonData || jsonData.length === 0) {
		return '';
	}

	// Get all unique keys from all objects
	const allKeys = new Set<string>();
	jsonData.forEach(obj => {
		if (obj && typeof obj === 'object') {
			Object.keys(obj).forEach(key => allKeys.add(key));
		}
	});

	const headers = Array.from(allKeys);
	
	// Escape CSV values (handle commas, quotes, newlines)
	const escapeCsvValue = (value: any): string => {
		if (value === null || value === undefined) {
			return '';
		}
		const str = String(value);
		// If contains comma, quote, or newline, wrap in quotes and escape quotes
		if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
			return `"${str.replace(/"/g, '""')}"`;
		}
		return str;
	};

	// Build CSV
	const csvRows: string[] = [];
	
	// Header row
	csvRows.push(headers.map(escapeCsvValue).join(','));

	// Data rows
	jsonData.forEach(obj => {
		const row = headers.map(header => {
			const value = obj && typeof obj === 'object' ? obj[header] : '';
			return escapeCsvValue(value);
		});
		csvRows.push(row.join(','));
	});

	return csvRows.join('\n');
}

export async function saveFile({
	content,
	fileName,
	mimeType = 'text/markdown',
	tabId,
	onError
}: SaveFileOptions): Promise<void> {
	try {
		if (mimeType === 'text/markdown' && !fileName.toLowerCase().endsWith('.md')) {
			fileName = `${fileName}.md`;
		}

		const browserType = await detectBrowser();
		const isSafari = ['ios', 'mobile-ios', 'ipad-os', 'safari', 'mobile-safari'].includes(browserType);
		
		if (isSafari) {
			const blob = new Blob([content], { type: 'application/json' });
			const file = new File([blob], fileName, { type: 'application/json' });
			const dataUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;

			// Use share API if there is no tab ID, e.g. in settings pages
			if (!tabId) {				
				if (navigator.share) {
					try {
						await navigator.share({
							files: [file],
							text: fileName
						});
					} catch (error) {
						console.error('Error sharing:', error);
						// Fallback to opening in a new tab if sharing fails
						window.open(dataUri);
					}
				} else {
					// Fallback for older iOS versions
					window.open(dataUri);
				}
				throw new Error('Tab ID is required for saving files in Safari');
			}

			await browser.scripting.executeScript({
				target: { tabId },
				func: (fileName: string, dataUri: string) => {
					const a = document.createElement('a');
					a.href = dataUri;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
				},
				args: [fileName, dataUri]
			});
		} else {
			const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		if (onError) {
			onError(error as Error);
		}
	}
} 
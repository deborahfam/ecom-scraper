import browser from './browser-polyfill';
import { callOpenRouter, OpenRouterMessage } from './openrouter';
import { debugLog } from './debug';
import { saveFile } from './file-utils';

interface SavedParserCode {
	code: string;
	url: string;
	title: string;
	generatedAt: number;
}

/**
 * Normalizes a URL to create a consistent key for storage
 */
function normalizeUrlForStorage(url: string): string {
	try {
		const urlObj = new URL(url);
		// Remove protocol, www, trailing slashes, and normalize
		let normalized = urlObj.hostname.replace(/^www\./, '') + urlObj.pathname;
		normalized = normalized.replace(/\/$/, ''); // Remove trailing slash
		// Replace invalid filename characters
		return normalized.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
	} catch {
		// Fallback if URL parsing fails
		return url.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
	}
}

/**
 * Sanitizes and repairs JSON string that may contain unescaped control characters
 * in string values, particularly in the "code" field.
 * This function finds the "code" field and properly escapes all control characters.
 */
function sanitizeJsonString(jsonString: string): string {
	// Find the start of the "code" field
	const codeFieldStart = jsonString.indexOf('"code"');
	if (codeFieldStart === -1) {
		return jsonString; // No code field found, return as-is
	}
	
	// Find the colon after "code"
	const colonIndex = jsonString.indexOf(':', codeFieldStart);
	if (colonIndex === -1) {
		return jsonString;
	}
	
	// Find the opening quote after the colon
	const quoteStart = jsonString.indexOf('"', colonIndex);
	if (quoteStart === -1) {
		return jsonString;
	}
	
	// Now find the closing quote, but we need to handle escaped quotes
	let quoteEnd = quoteStart + 1;
	let foundEnd = false;
	
	while (quoteEnd < jsonString.length && !foundEnd) {
		const nextQuote = jsonString.indexOf('"', quoteEnd);
		if (nextQuote === -1) {
			break; // No closing quote found
		}
		
		// Check if this quote is escaped
		let backslashCount = 0;
		for (let i = nextQuote - 1; i >= 0 && jsonString[i] === '\\'; i--) {
			backslashCount++;
		}
		
		// If even number of backslashes (or zero), the quote is not escaped
		if (backslashCount % 2 === 0) {
			quoteEnd = nextQuote;
			foundEnd = true;
		} else {
			quoteEnd = nextQuote + 1;
		}
	}
	
	if (!foundEnd) {
		return jsonString; // Couldn't find proper closing quote
	}
	
	// Extract the code content (between the quotes)
	const codeContent = jsonString.substring(quoteStart + 1, quoteEnd);
	
	// Escape control characters
	const escaped = codeContent
		.replace(/\\/g, '\\\\')  // Escape backslashes first
		.replace(/\n/g, '\\n')   // Newlines
		.replace(/\r/g, '\\r')   // Carriage returns
		.replace(/\t/g, '\\t')   // Tabs
		.replace(/\f/g, '\\f')   // Form feeds
		.replace(/\v/g, '\\v')   // Vertical tabs
		.replace(/[\x00-\x1F]/g, (char: string) => {
			// Escape other control characters
			const code = char.charCodeAt(0);
			return `\\u${code.toString(16).padStart(4, '0')}`;
		});
	
	// Reconstruct the JSON string
	return jsonString.substring(0, quoteStart + 1) + escaped + jsonString.substring(quoteEnd);
}

/**
 * Checks if a saved URL is a prefix of the current URL (for subpage matching)
 * @param savedUrl - The URL that was saved
 * @param currentUrl - The current page URL
 * @returns true if savedUrl is a prefix of currentUrl
 */
function isUrlPrefix(savedUrl: string, currentUrl: string): boolean {
	try {
		const savedUrlObj = new URL(savedUrl);
		const currentUrlObj = new URL(currentUrl);
		
		// Must match protocol and hostname
		if (savedUrlObj.protocol !== currentUrlObj.protocol || 
		    savedUrlObj.hostname !== currentUrlObj.hostname) {
			return false;
		}
		
		// Check if saved pathname is a prefix of current pathname
		const savedPath = savedUrlObj.pathname.replace(/\/$/, ''); // Remove trailing slash
		const currentPath = currentUrlObj.pathname;
		
		// Exact match or saved path is a prefix of current path
		return currentPath === savedPath || currentPath.startsWith(savedPath + '/');
	} catch {
		// Fallback: simple string prefix check
		return currentUrl.startsWith(savedUrl);
	}
}

const PARSER_SYSTEM_PROMPT = `You are an expert e-commerce data extraction engineer. 
Your task is to generate a standalone JavaScript function named 'extractProducts' that parses a given string of text (HTML or Markdown) and returns a list of product objects.

The 'Product' object structure MUST be:
{
  "name": string | null,
  "priceRaw": string | null,
  "priceNormalized": number | null,
  "currency": string | null,
  "images": string[] | [],
  "availability": string | null,
  "url": string | null,
  "attributes": Record<string, any> | {}
}

Requirements for the generated code:
1. The function 'extractProducts(text)' must be self-contained.
2. It should handle common e-commerce patterns (JSON-LD, Meta tags, or generic DOM structures represented in text).
3. If a property is not found, it MUST be null (or [] for images, {} for attributes).
4. The output must be a valid JavaScript array of these objects.
5. Return ONLY the executable JavaScript code. No explanations, no markdown formatting, no backticks.

CRITICAL: You MUST respond with a valid JSON object in this exact format:
{
  "explanation": "Brief explanation of the parsing strategy used",
  "code": "The complete JavaScript code for the extractProducts function."
}
`;

export async function generateAndSaveParser(sampleText: string, pageTitle: string, pageUrl: string, tabId?: number): Promise<string> {
	debugLog('ParserGenerator', 'Requesting parser generation from OpenRouter...');
	
	const userMessage = `Analyze this e-commerce text and generate the 'extractProducts' function:\n\n${sampleText}`;
	const messages: OpenRouterMessage[] = [
		{ role: 'system', content: PARSER_SYSTEM_PROMPT },
		{ role: 'user', content: userMessage }
	];

	// Print the complete prompt for debugging
	console.log('=== COMPLETE PROMPT SENT TO LLM ===');
	console.log('SYSTEM PROMPT:');
	console.log(PARSER_SYSTEM_PROMPT);
	console.log('\nUSER MESSAGE:');
	console.log(userMessage);
	console.log('=== END OF PROMPT ===\n');

	let response: string | undefined;
	try {
		response = await callOpenRouter(messages);
		
		debugLog('ParserGenerator', 'Response received, parsing JSON...');
		console.log('=== LLM RESPONSE ===');
		console.log(response);
		console.log('=== END OF LLM RESPONSE ===\n');
		
		// Parse the JSON response
		let parsedResponse: { explanation: string; code: string };
		
		// First, try to extract JSON from markdown code blocks
		let jsonToParse = response;
		
		// Check if response contains markdown code blocks
		const jsonCodeBlockMatch = response.match(/```(?:json)?\s*(\{[\s\S]*"explanation"[\s\S]*"code"[\s\S]*\})\s*```/);
		if (jsonCodeBlockMatch) {
			console.log('Found JSON in markdown code block, extracting...');
			jsonToParse = jsonCodeBlockMatch[1];
		} else {
			// Try to find JSON object anywhere in the response
			const jsonObjectMatch = response.match(/\{[\s\S]*"explanation"[\s\S]*"code"[\s\S]*\}/);
			if (jsonObjectMatch) {
				console.log('Found JSON object in response, extracting...');
				jsonToParse = jsonObjectMatch[0];
			}
		}
		
		try {
			// Try to parse as JSON first
			parsedResponse = JSON.parse(jsonToParse);
			console.log('Successfully parsed JSON directly');
		} catch (parseError) {
			console.error('=== JSON PARSING ERROR ===');
			console.error('Parse error:', parseError);
			console.error('Response length:', response.length);
			console.error('JSON to parse length:', jsonToParse.length);
			console.error('JSON preview (first 500 chars):', jsonToParse.substring(0, 500));
			
			// Try to sanitize and repair the JSON
			try {
				console.log('Attempting to sanitize JSON...');
				const sanitized = sanitizeJsonString(jsonToParse);
				parsedResponse = JSON.parse(sanitized);
				console.log('Successfully parsed after sanitization');
			} catch (sanitizeError) {
				console.error('Sanitization failed:', sanitizeError);
				
				// Last resort: try to manually extract the code field using regex
				console.log('Attempting manual extraction...');
				const codeMatch = jsonToParse.match(/"code"\s*:\s*"([\s\S]*?)"\s*[,\}]/);
				const explanationMatch = jsonToParse.match(/"explanation"\s*:\s*"([\s\S]*?)"\s*[,\}]/);
				
				if (codeMatch) {
					// Unescape the code manually
					const rawCode = codeMatch[1]
						.replace(/\\n/g, '\n')
						.replace(/\\r/g, '\r')
						.replace(/\\t/g, '\t')
						.replace(/\\"/g, '"')
						.replace(/\\\\/g, '\\');
					
					parsedResponse = {
						explanation: explanationMatch ? explanationMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : 'No explanation provided',
						code: rawCode
					};
					console.log('Successfully extracted code manually');
				} else {
					// Fallback: assume the entire response is the code if no JSON structure found
					console.warn('Could not parse JSON response, using entire response as code');
					parsedResponse = {
						explanation: 'No explanation provided',
						code: response
					};
				}
			}
		}
		
		if (!parsedResponse.code) {
			console.error('=== MISSING CODE FIELD ERROR ===');
			console.error('Parsed response:', parsedResponse);
			throw new Error('The LLM response does not contain a "code" field');
		}
		
		debugLog('ParserGenerator', `Explanation: ${parsedResponse.explanation}`);
		debugLog('ParserGenerator', 'Code extracted, saving to file and storage...');
		
		const sanitizedTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled';
		const fileName = `code-generated/${sanitizedTitle}/generated-product-parser.js`;
		
		// Before saving, remove any existing parser entries that are related to this URL
		// (either the saved URL is a prefix of current URL, or current URL is a prefix of saved URL)
		try {
			const allStorage = await browser.storage.local.get(null);
			const keysToRemove: string[] = [];
			
			for (const [key, value] of Object.entries(allStorage)) {
				if (key.startsWith('parser_code_')) {
					const data = value as SavedParserCode;
					if (data && data.url) {
						// Check if URLs are related (one is prefix of the other)
						if (isUrlPrefix(data.url, pageUrl) || isUrlPrefix(pageUrl, data.url)) {
							keysToRemove.push(key);
							debugLog('ParserGenerator', `Removing existing parser entry: ${key} (URL: ${data.url})`);
						}
					}
				}
			}
			
			if (keysToRemove.length > 0) {
				await browser.storage.local.remove(keysToRemove);
				debugLog('ParserGenerator', `Removed ${keysToRemove.length} existing parser entry/entries`);
			}
		} catch (error) {
			console.warn('Error removing existing parser entries:', error);
			// Continue with save even if removal fails
		}
		
		// Save to file
		await saveFile({
			content: parsedResponse.code,
			fileName: fileName,
			mimeType: 'text/javascript',
			tabId
		});
		
		// Save to storage using normalized URL as key
		const storageKey = `parser_code_${normalizeUrlForStorage(pageUrl)}`;
		await browser.storage.local.set({
			[storageKey]: {
				code: parsedResponse.code,
				url: pageUrl,
				title: pageTitle,
				generatedAt: Date.now()
			}
		});
		
		debugLog('ParserGenerator', 'File and storage saved successfully.');
		
		// Return the generated code
		return parsedResponse.code;
	} catch (error) {
		console.error('=== ERROR IN GENERATE AND SAVE PARSER ===');
		console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
		console.error('Error message:', error instanceof Error ? error.message : String(error));
		console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace available');
		
		if (response) {
			console.error('LLM Response that caused error:');
			console.error(response);
		}
		
		console.error('=== END OF ERROR DETAILS ===');
		
		throw error;
	}
}

/**
 * Loads saved parser code for a given URL
 * First tries exact match, then tries prefix matching for subpages
 * @param pageUrl - The URL of the page
 * @returns The saved parser code or null if not found
 */
export async function loadSavedParserCode(pageUrl: string): Promise<string | null> {
	try {
		// First, try exact match
		const storageKey = `parser_code_${normalizeUrlForStorage(pageUrl)}`;
		const result = await browser.storage.local.get(storageKey);
		
		const savedData = result[storageKey] as SavedParserCode | undefined;
		if (savedData && savedData.code) {
			debugLog('ParserGenerator', `Found saved parser code (exact match) for URL: ${pageUrl}`);
			return savedData.code;
		}
		
		// If no exact match, try prefix matching for subpages
		debugLog('ParserGenerator', `No exact match found, searching for prefix matches...`);
		const allStorage = await browser.storage.local.get(null);
		
		// Find all parser code entries
		const parserEntries: Array<{ key: string; data: SavedParserCode }> = [];
		for (const [key, value] of Object.entries(allStorage)) {
			if (key.startsWith('parser_code_')) {
				const data = value as SavedParserCode;
				if (data && data.url && data.code) {
					parserEntries.push({ key, data });
				}
			}
		}
		
		// Sort by URL length (longer paths first) to prefer more specific matches
		parserEntries.sort((a, b) => b.data.url.length - a.data.url.length);
		
		// Find the first entry where the saved URL is a prefix of the current URL
		for (const entry of parserEntries) {
			if (isUrlPrefix(entry.data.url, pageUrl)) {
				debugLog('ParserGenerator', `Found saved parser code (prefix match) for URL: ${pageUrl} (matched with: ${entry.data.url})`);
				return entry.data.code;
			}
		}
		
		debugLog('ParserGenerator', `No saved parser code found for URL: ${pageUrl}`);
		return null;
	} catch (error) {
		console.error('Error loading saved parser code:', error);
		return null;
	}
}


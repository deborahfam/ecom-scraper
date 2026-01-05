import { callOpenRouter, OpenRouterMessage } from './openrouter';
import { debugLog } from './debug';
import { saveFile } from './file-utils';

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
5. Return ONLY the executable JavaScript code. No explanations, no markdown formatting, no backticks.`;

export async function generateAndSaveParser(sampleText: string, pageTitle: string, tabId?: number): Promise<void> {
	debugLog('ParserGenerator', 'Requesting parser generation from OpenRouter...');
	
	const messages: OpenRouterMessage[] = [
		{ role: 'system', content: PARSER_SYSTEM_PROMPT },
		{ role: 'user', content: `Analyze this e-commerce text and generate the 'extractProducts' function:\n\n${sampleText}` }
	];

	try {
		const generatedCode = await callOpenRouter(messages);
		
		debugLog('ParserGenerator', 'Parser code received, saving to file...');
		
		const sanitizedTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled';
		const fileName = `generatecode/${sanitizedTitle}/generated-product-parser.js`;
		
		await saveFile({
			content: generatedCode,
			fileName: fileName,
			mimeType: 'text/javascript',
			tabId
		});
		
		debugLog('ParserGenerator', 'File saved successfully.');
	} catch (error) {
		console.error('Error in generateAndSaveParser:', error);
		throw error;
	}
}


import browser from './browser-polyfill';
import { debugLog } from './debug';

/**
 * Executes JavaScript code in the page context using browser.scripting.executeScript
 * This avoids CSP restrictions by executing in the page context rather than extension context
 * @param code - The JavaScript code to execute
 * @param inputText - The HTML string to parse
 * @param tabId - The tab ID where to execute the code
 * @returns The result of executing the code (should be an array of products)
 */
export async function executeParserCode(code: string, inputText: string, tabId: number): Promise<any[]> {
	debugLog('CodeExecutor', 'Executing parser code in page context...');
	
	try {
		// Execute the script in the page context using MAIN world
		// In MAIN world, we can use Function constructor which is allowed
		const results = await browser.scripting.executeScript({
			target: { tabId: tabId },
			world: 'MAIN',
			func: (parserCode: string, textToParse: string) => {
				// Build the complete execution code
				const fullCode = `
					${parserCode}
					
					if (typeof extractProducts !== 'function') {
						throw new Error('extractProducts function not found in generated code');
					}
					
					return extractProducts(${JSON.stringify(textToParse)});
				`;
				
				// Use Function constructor in MAIN world (page context)
				// This is allowed because we're executing in the page's context, not extension context
				const executor = new Function(fullCode);
				return executor();
			},
			args: [code, inputText]
		});
		
		if (!results || results.length === 0) {
			throw new Error('No results returned from script execution');
		}
		
		const result = results[0].result;
		
		// Validate that the result is an array
		if (!Array.isArray(result)) {
			console.warn('Parser code did not return an array, converting...');
			return [result].filter(Boolean);
		}
		
		debugLog('CodeExecutor', `Successfully extracted ${result.length} products`);
		return result;
		
	} catch (error) {
		console.error('Error executing parser code:', error);
		throw new Error(`Failed to execute parser code: ${error instanceof Error ? error.message : String(error)}`);
	}
}


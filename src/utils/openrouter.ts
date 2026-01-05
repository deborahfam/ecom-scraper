import { debugLog } from './debug';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface OpenRouterResponse {
	choices: {
		message: {
			content: string;
		};
	}[];
}

export async function callOpenRouter(
	messages: OpenRouterMessage[],
	model: string = process.env.OPENROUTER_MODEL || 'meta-llama/llama-4-maverick'
): Promise<string> {
	const apiKey = process.env.OPENROUTER_API_KEY;

	if (!apiKey) {
		throw new Error('OPENROUTER_API_KEY is not defined');
	}

	debugLog('OpenRouter', `Sending request to model: ${model}`);

	try {
		const response = await fetch(OPENROUTER_API_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
				'HTTP-Referer': 'https://github.com/dbyta/ecom-scraper', // Optional, for OpenRouter rankings
				'X-Title': 'E-commerce Scraper', // Optional
			},
			body: JSON.stringify({
				model: model,
				messages: messages,
			}),
		});

		if (!response.ok) {
			const errorData = await response.json();
			throw new Error(`OpenRouter API error: ${response.statusText} ${JSON.stringify(errorData)}`);
		}

		const data: OpenRouterResponse = await response.json();
		const content = data.choices[0]?.message?.content;

		if (!content) {
			throw new Error('No content returned from OpenRouter');
		}

		debugLog('OpenRouter', 'Received response');
		return content;
	} catch (error) {
		console.error('Error calling OpenRouter:', error);
		throw error;
	}
}


import dayjs from 'dayjs';
import { Template, Property } from '../types/types';
import { incrementStat, addHistoryEntry, getClipHistory } from '../utils/storage-utils';
import { generateFrontmatter, saveNote } from '../utils/url-utils';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { decompressFromUTF16 } from 'lz-string';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { getLocalStorage, setLocalStorage, loadSettings, generalSettings, Settings } from '../utils/storage-utils';
import { escapeHtml, unescapeValue } from '../utils/string-utils';
import { loadTemplates, createDefaultTemplate } from '../managers/template-manager';
import browser from '../utils/browser-polyfill';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import { createElementWithClass } from '../utils/dom-utils';
import { adjustNoteNameHeight } from '../utils/ui-utils';
import { debugLog } from '../utils/debug';
import { showVariables, initializeVariablesPanel, updateVariablesPanel } from '../managers/inspect-variables';
import { isBlankPage, isValidUrl } from '../utils/active-tab-manager';
import { memoizeWithExpiration } from '../utils/memoize';
import { debounce } from '../utils/debounce';
import { sanitizeFileName } from '../utils/string-utils';
import { saveFile } from '../utils/file-utils';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { generateAndSaveParser, loadSavedParserCode } from '../utils/parser-generator';
import { executeParserCode } from '../utils/code-executor';

interface ReaderModeResponse {
	success: boolean;
	isActive: boolean;
}

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
let lastSelectedVault: string | null = null;
let shouldStopScraper: boolean = false;

const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';

// Memoize compileTemplate with a short expiration and URL-sensitive key
const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 50,
		keyFn: (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => 
			`${tabId}-${template}-${currentUrl}`
	}
);

// Memoize generateFrontmatter with a longer expiration
const memoizedGenerateFrontmatter = memoizeWithExpiration(
	async (properties: Property[]) => {
		return generateFrontmatter(properties);
	},
	{ expirationMs: 50 }
);

// Helper function to get tab info from background script
async function getTabInfo(tabId: number): Promise<{ id: number; url: string }> {
	const response = await browser.runtime.sendMessage({ action: "getTabInfo", tabId }) as { success?: boolean; tab?: { id: number; url: string }; error?: string };
	if (!response || !response.success || !response.tab) {
		throw new Error((response && response.error) || 'Failed to get tab info');
	}
	return response.tab;
}

// Helper function to get current tab URL and title for stats
async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (!currentTabId) {
		return { url: '' };
	}
	
	try {
		const tab = await getTabInfo(currentTabId);
		// Try to get the title from the extracted content if available
		const extractedData = await memoizedExtractPageContent(currentTabId);
		return { 
			url: tab.url, 
			title: extractedData?.title || document.title 
		};
	} catch (error) {
		console.warn('Failed to get current tab info for stats:', error);
		return { url: '' };
	}
}

// Memoize extractPageContent with URL-sensitive key and short expiration
const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		await getTabInfo(tabId);
		return extractPageContent(tabId);
	},
	{ 
		expirationMs: 50, 
		keyFn: async (tabId: number) => {
			const tab = await getTabInfo(tabId);
			return `${tabId}-${tab.url}`;
		}
	}
);

// Width is used to update the note name field height
let previousWidth = window.innerWidth;

function setPopupDimensions() {
	// Get the actual height of the popup after the browser has determined its maximum
	const actualHeight = document.documentElement.offsetHeight;
	
	// Calculate the viewport height and width
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	
	// Use the smaller of the two heights
	const finalHeight = Math.min(actualHeight, viewportHeight);
	
	// Set the --popup-height CSS variable to the final height
	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	// Check if the width has changed
	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;
		
		// Adjust the note name field height
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100); // 100ms delay

async function initializeExtension(tabId: number) {
	try {
		// Initialize translations
		await translatePage();
		
		// Setup language and RTL support
		await setupLanguageAndDirection();
		
		// First, add the browser class to allow browser-specific styles to apply
		await addBrowserClassToHtml();
		
		// Set an initial large height to allow the browser to determine the maximum height
		// This is necessary for browsers that allow scaling the popup via page zoom
		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');
		
		// Use setTimeout to ensure the DOM has updated before we measure
		setTimeout(() => {
			setPopupDimensions();
		}, 0);

		loadedSettings = await loadSettings();
		debugLog('Settings', 'General settings:', loadedSettings);

		templates = await loadTemplates();
		debugLog('Templates', 'Loaded templates:', templates);

		if (templates.length === 0) {
			console.error('No templates loaded');
			return false;
		}

		// Initialize triggers to speed up template matching
		initializeTriggers(templates);

		currentTemplate = templates[0];
		debugLog('Templates', 'Current template set to:', currentTemplate);

		// Load last selected vault
		lastSelectedVault = await getLocalStorage('lastSelectedVault');
		if (!lastSelectedVault && loadedSettings.vaults.length > 0) {
			lastSelectedVault = loadedSettings.vaults[0];
		}
		debugLog('Vaults', 'Last selected vault:', lastSelectedVault);

		updateVaultDropdown(loadedSettings.vaults);

		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}

		await loadAndSetupTemplates();

		// Setup message listeners
		setupMessageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

async function loadAndSetupTemplates() {
	const data = await browser.storage.sync.get(['template_list']);
	const templateIds = data.template_list || [];
	const loadedTemplates = await Promise.all((templateIds as string[]).map(async (id: string) => {
		try {
			const result = await browser.storage.sync.get(`template_${id}`);
			const compressedChunks = result[`template_${id}`] as string[];
			if (compressedChunks) {
				const decompressedData = decompressFromUTF16(compressedChunks.join(''));
				const template = JSON.parse(decompressedData);
				if (template && Array.isArray(template.properties)) {
					return template;
				}
			}
		} catch (error) {
			console.error(`Error parsing template ${id}:`, error);
		}
		return null;
	}));

	templates = loadedTemplates.filter((t: Template | null): t is Template => t !== null);

	if (templates.length === 0) {
		currentTemplate = createDefaultTemplate();
		templates = [currentTemplate];
	} else {
		currentTemplate = templates[0];
	}
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener((request: any, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void) => {
		if (request.action === "triggerQuickClip") {
			// Quick clip functionality removed - saveNote is no longer available
			console.warn('Quick clip action is no longer supported - saveNote functionality has been removed');
			sendResponse({success: false, error: 'Quick clip is no longer available'});
			return true;
		} else if (request.action === "tabUrlChanged") {
			if (request.tabId === currentTabId) {
				if (currentTabId !== undefined) {
					refreshFields(currentTabId);
				}
			}
		} else if (request.action === "activeTabChanged") {
			// Only handle active tab changes if we're in side panel mode, not iframe mode
			if (!isIframe) {
				currentTabId = request.tabId;
				if (request.isValidUrl) {
					if (currentTabId !== undefined) {
						refreshFields(currentTabId); // Force template check when URL changes
					}
				} else if (request.isBlankPage) {
					showError(getMessage('pageCannotBeClipped'));
				} else {
					showError(getMessage('onlyHttpSupported'));
				}
			}
		} else if (request.action === "highlightsUpdated") {
			if (request.tabId === currentTabId) {
				// Refresh fields when highlights are updated
				if (currentTabId !== undefined) {
					refreshFields(currentTabId);
				}
			}
		} else if (request.action === "updatePopupHighlighterUI") {
			// This message is now handled by checkHighlighterModeState
		} else if (request.action === "highlighterModeChanged") {
			// This message is now handled by checkHighlighterModeState
		}
	});
}

document.addEventListener('DOMContentLoaded', async function() {
	const settings = await loadSettings();
	if (isIframe) {
		document.documentElement.classList.add('is-embedded');
	}

	const isSidePanel = document.documentElement.classList.contains('is-side-panel');

	try {
		// Get the active tab via background script to handle Firefox compatibility
		const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
		if (!response || response.error || !response.tabId) {
			showError(getMessage('pleaseReload'));
			return;
		}
		
		currentTabId = response.tabId;
		const tab = await getTabInfo(currentTabId);
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile ? 'popup' : settings.openBehavior;

		// Check if we should open in an iframe, but only if the URL is valid
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'embedded' && !isIframe && !isSidePanel) {
			try {
				const response = await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" }) as { success?: boolean; error?: string };
				if (response && response.success) {
					window.close();
					return; // Exit script after closing the window
				} else if (response && response.error) {
					console.error('Error toggling iframe:', response.error);
					// If there's an error, we'll fall through and open the normal popup.
				}
			} catch (error) {
				console.error('Error toggling iframe:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Connect to the background script for communication
		browser.runtime.connect({ name: 'popup' });

		// Setup event listeners for popup buttons
		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			refreshButton.addEventListener('click', (e) => {
				e.preventDefault();
				refreshPopup();
				initializeIcons(refreshButton);
			});
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "openOptionsPage" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		const saveJsonBtn = document.getElementById('save-json-btn') as HTMLButtonElement;
		if (saveJsonBtn) {
			saveJsonBtn.addEventListener('click', async (e) => {
				e.preventDefault();
				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
				if (noteContentField && noteNameField && currentTabId) {
					const obtainProductsBtn = document.getElementById('obtain-products-btn') as HTMLButtonElement;
					try {
						saveJsonBtn.classList.add('processing');
						saveJsonBtn.textContent = getMessage('processing');
						saveJsonBtn.disabled = true;
						
						// Also disable the obtain products button
						if (obtainProductsBtn) {
							obtainProductsBtn.disabled = true;
						}
						
						// Get current page URL
						const tab = await getTabInfo(currentTabId);
						const pageUrl = tab.url;
						
						// Step 1: Generate the parser code
						debugLog('SaveJson', 'Generating parser code...');
						const generatedCode = await generateAndSaveParser(noteContentField.value, noteNameField.value, pageUrl, currentTabId);
						
						// Step 2: Execute the code on the note content
						debugLog('SaveJson', 'Executing parser code...');
						if (!currentTabId) {
							throw new Error('Tab ID is required to execute parser code');
						}
						const extractedProducts = await executeParserCode(generatedCode, noteContentField.value, currentTabId);
						
						// Step 3: Save the JSON result
						debugLog('SaveJson', 'Saving JSON result...');
						const sanitizedTitle = noteNameField.value.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled';
						const jsonFileName = `code-generated/${sanitizedTitle}/extracted-products.json`;
						
						await saveFile({
							content: JSON.stringify(extractedProducts, null, 2),
							fileName: jsonFileName,
							mimeType: 'application/json',
							tabId: currentTabId
						});
						
						debugLog('SaveJson', 'Process completed successfully');
					} catch (error) {
						console.error('Failed to save JSON:', error);
						alert(getMessage('saveJsonError'));
					} finally {
						saveJsonBtn.classList.remove('processing');
						saveJsonBtn.textContent = getMessage('generateCodeAndSave');
						saveJsonBtn.disabled = false;
						
						// Re-enable the obtain products button
						if (obtainProductsBtn) {
							obtainProductsBtn.disabled = false;
						}
					}
				}
			});
		}

		const obtainProductsBtn = document.getElementById('obtain-products-btn') as HTMLButtonElement;
		if (obtainProductsBtn) {
			obtainProductsBtn.addEventListener('click', async (e) => {
				e.preventDefault();
				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
				if (noteContentField && noteNameField && currentTabId) {
					const saveJsonBtn = document.getElementById('save-json-btn') as HTMLButtonElement;
					try {
						obtainProductsBtn.classList.add('processing');
						obtainProductsBtn.textContent = getMessage('processing');
						obtainProductsBtn.disabled = true;
						
						// Also disable the save JSON button
						if (saveJsonBtn) {
							saveJsonBtn.disabled = true;
						}
						
						// Get current page URL
						const tab = await getTabInfo(currentTabId);
						const pageUrl = tab.url;
						
						// Step 1: Load saved parser code for this URL
						debugLog('ObtainProducts', 'Loading saved parser code...');
						const savedCode = await loadSavedParserCode(pageUrl);
						
						if (!savedCode) {
							throw new Error('No saved parser code found for this page. Please use "Save JSON" first to generate the parser code.');
						}
						
						// Step 2: Execute the saved code on the note content
						debugLog('ObtainProducts', 'Executing saved parser code...');
						const extractedProducts = await executeParserCode(savedCode, noteContentField.value, currentTabId);
						
						// Step 3: Save the JSON result
						debugLog('ObtainProducts', 'Saving JSON result...');
						const sanitizedTitle = noteNameField.value.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled';
						const jsonFileName = `code-generated/${sanitizedTitle}/extracted-products.json`;
						
						await saveFile({
							content: JSON.stringify(extractedProducts, null, 2),
							fileName: jsonFileName,
							mimeType: 'application/json',
							tabId: currentTabId
						});
						
						debugLog('ObtainProducts', 'Process completed successfully');
					} catch (error) {
						console.error('Failed to obtain products:', error);
						alert(getMessage('obtainProductsError'));
					} finally {
						obtainProductsBtn.classList.remove('processing');
						obtainProductsBtn.textContent = getMessage('obtainProducts');
						obtainProductsBtn.disabled = false;
						
						// Re-enable the save JSON button
						if (saveJsonBtn) {
							saveJsonBtn.disabled = false;
						}
					}
				}
			});
		}

		/**
		 * Builds a URL with pagination parameter
		 * Uses 'page' or 'pagina' parameter based on usePaginaParam setting
		 */
		function buildPaginationUrl(baseUrl: string, pageNumber: number, usePaginaParam: boolean): string {
			try {
				const url = new URL(baseUrl);
				
				if (usePaginaParam) {
					url.searchParams.set('pagina', pageNumber.toString());
				} else {
					url.searchParams.set('page', pageNumber.toString());
				}
				
				return url.toString();
			} catch (error) {
				console.error('Error building pagination URL:', error);
				// Fallback: simple string replacement
				const paramName = usePaginaParam ? 'pagina' : 'page';
				if (baseUrl.includes(`${paramName}=`)) {
					return baseUrl.replace(new RegExp(`${paramName}=\\d+`), `${paramName}=${pageNumber}`);
				} else {
					const separator = baseUrl.includes('?') ? '&' : '?';
					return `${baseUrl}${separator}${paramName}=${pageNumber}`;
				}
			}
		}

		/**
		 * Normalizes URLs for comparison (removes trailing slashes, normalizes query params)
		 */
		function normalizeUrlForComparison(url: string): string {
			try {
				const urlObj = new URL(url);
				// Sort query parameters for consistent comparison
				const sortedParams = Array.from(urlObj.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
				urlObj.search = '';
				sortedParams.forEach(([key, value]) => {
					urlObj.searchParams.append(key, value);
				});
				return urlObj.toString().replace(/\/$/, '');
			} catch {
				return url.replace(/\/$/, '');
			}
		}

		/**
		 * Navigates to a URL and waits for it to load, then extracts page content
		 */
		async function navigateAndExtractContent(tabId: number, url: string): Promise<string> {
			return new Promise((resolve, reject) => {
				let timeoutId: number | null = null;
				let resolved = false;
				const normalizedTargetUrl = normalizeUrlForComparison(url);
				
				debugLog('NavigateAndExtract', `Navigating to: ${url}`);
				
				// Set a timeout to prevent infinite waiting
				const maxWaitTime = 30000; // 30 seconds max
				timeoutId = window.setTimeout(() => {
					if (!resolved) {
						resolved = true;
						browser.tabs.onUpdated.removeListener(onUpdatedListener);
						reject(new Error(`Timeout waiting for page to load: ${url}`));
					}
				}, maxWaitTime);
				
				// Wait for the page to load using tabs.onUpdated listener approach
				const onUpdatedListener = async (updatedTabId: number, changeInfo: browser.Tabs.OnUpdatedChangeInfoType, updatedTab: browser.Tabs.Tab | undefined) => {
					if (updatedTabId !== tabId) return;
					
					// Check if page is loading
					if (changeInfo.status === 'loading') {
						debugLog('NavigateAndExtract', `Page ${updatedTabId} is loading...`);
						return;
					}
					
					// Check if page is complete
					if (changeInfo.status === 'complete' && updatedTab) {
						const currentUrl = updatedTab.url || '';
						const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
						
						debugLog('NavigateAndExtract', `Page ${updatedTabId} complete. Current URL: ${currentUrl}, Target: ${url}`);
						
						// Check if URLs match (allowing for slight differences)
						if (normalizedCurrentUrl === normalizedTargetUrl || currentUrl.includes(url.split('?')[0])) {
							// Remove the listener
							browser.tabs.onUpdated.removeListener(onUpdatedListener);
							
							if (resolved) return;
							resolved = true;
							
							if (timeoutId) {
								clearTimeout(timeoutId);
							}
							
							debugLog('NavigateAndExtract', 'URLs match, waiting for content script...');
							
							// Wait a bit more for content script and DOM to be ready
							setTimeout(async () => {
								try {
									// Ensure content script is loaded - try multiple times
									let contentScriptReady = false;
									for (let attempt = 0; attempt < 5; attempt++) {
										try {
											await browser.runtime.sendMessage({ 
												action: "sendMessageToTab", 
												tabId: tabId, 
												message: { action: "ping" }
											});
											contentScriptReady = true;
											debugLog('NavigateAndExtract', `Content script ready (attempt ${attempt + 1})`);
											break;
										} catch (pingError) {
											debugLog('NavigateAndExtract', `Content script ping failed (attempt ${attempt + 1}), injecting...`);
											try {
												await browser.scripting.executeScript({
													target: { tabId: tabId },
													files: ['content.js']
												});
												// Wait after injection
												await new Promise(resolve => setTimeout(resolve, 1500));
											} catch (injectError) {
												console.warn('Content script injection failed:', injectError);
											}
										}
									}
									
									if (!contentScriptReady) {
										debugLog('NavigateAndExtract', 'Content script not ready after attempts, trying to extract anyway...');
									}
									
									// Extract page content - try multiple times
									let contentResponse = null;
									for (let attempt = 0; attempt < 3; attempt++) {
										try {
											contentResponse = await extractPageContent(tabId);
											if (contentResponse && contentResponse.content) {
												debugLog('NavigateAndExtract', `Content extracted successfully (attempt ${attempt + 1})`);
												break;
											}
										} catch (extractError) {
											console.warn(`Content extraction attempt ${attempt + 1} failed:`, extractError);
											if (attempt < 2) {
												await new Promise(resolve => setTimeout(resolve, 1000));
											}
										}
									}
									
									if (contentResponse && contentResponse.content) {
										resolve(contentResponse.content);
									} else {
										reject(new Error('Failed to extract page content after multiple attempts'));
									}
								} catch (error) {
									reject(error);
								}
							}, 3000); // Wait 3 seconds for content to be ready
						}
					}
				};
				
				// Add the listener BEFORE navigating
				browser.tabs.onUpdated.addListener(onUpdatedListener);
				
				// Navigate to the URL
				browser.tabs.update(tabId, { url: url }).then(() => {
					debugLog('NavigateAndExtract', 'Navigation command sent');
					// Also check immediately in case the page is already loaded
					browser.tabs.get(tabId).then((tab) => {
						if (tab.status === 'complete') {
							const currentUrl = tab.url || '';
							const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
							if (normalizedCurrentUrl === normalizedTargetUrl) {
								debugLog('NavigateAndExtract', 'Page already loaded');
								onUpdatedListener(tabId, { status: 'complete' }, tab);
							}
						}
					}).catch(() => {
						// Ignore errors, the listener will handle it
					});
				}).catch((error) => {
					browser.tabs.onUpdated.removeListener(onUpdatedListener);
					if (timeoutId) {
						clearTimeout(timeoutId);
					}
					reject(error);
				});
			});
		}

		/**
		 * Navigates to a URL, extracts HTML, converts to markdown, and returns the markdown
		 * This is the complete flow: navigate -> get HTML -> get markdown -> apply scraper
		 */
		async function navigateAndExtractMarkdown(tabId: number, url: string): Promise<string> {
			return new Promise((resolve, reject) => {
				let timeoutId: number | null = null;
				let resolved = false;
				const normalizedTargetUrl = normalizeUrlForComparison(url);
				
				debugLog('NavigateAndExtractMarkdown', `Navigating to: ${url}`);
				
				// Set a timeout to prevent infinite waiting
				const maxWaitTime = 30000; // 30 seconds max
				timeoutId = window.setTimeout(() => {
					if (!resolved) {
						resolved = true;
						browser.tabs.onUpdated.removeListener(onUpdatedListener);
						reject(new Error(`Timeout waiting for page to load: ${url}`));
					}
				}, maxWaitTime);
				
				// Wait for the page to load using tabs.onUpdated listener approach
				const onUpdatedListener = async (updatedTabId: number, changeInfo: browser.Tabs.OnUpdatedChangeInfoType, updatedTab: browser.Tabs.Tab | undefined) => {
					if (updatedTabId !== tabId) return;
					
					// Check if page is loading
					if (changeInfo.status === 'loading') {
						debugLog('NavigateAndExtractMarkdown', `Page ${updatedTabId} is loading...`);
						return;
					}
					
					// Check if page is complete
					if (changeInfo.status === 'complete' && updatedTab) {
						const currentUrl = updatedTab.url || '';
						const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
						
						debugLog('NavigateAndExtractMarkdown', `Page ${updatedTabId} complete. Current URL: ${currentUrl}, Target: ${url}`);
						
						// Check if URLs match (allowing for slight differences)
						if (normalizedCurrentUrl === normalizedTargetUrl || currentUrl.includes(url.split('?')[0])) {
							// Remove the listener
							browser.tabs.onUpdated.removeListener(onUpdatedListener);
							
							if (resolved) return;
							resolved = true;
							
							if (timeoutId) {
								clearTimeout(timeoutId);
							}
							
							debugLog('NavigateAndExtractMarkdown', 'URLs match, waiting for content script...');
							
							// Wait a bit more for content script and DOM to be ready
							setTimeout(async () => {
								try {
									// Ensure content script is loaded - try multiple times
									let contentScriptReady = false;
									for (let attempt = 0; attempt < 5; attempt++) {
										try {
											await browser.runtime.sendMessage({ 
												action: "sendMessageToTab", 
												tabId: tabId, 
												message: { action: "ping" }
											});
											contentScriptReady = true;
											debugLog('NavigateAndExtractMarkdown', `Content script ready (attempt ${attempt + 1})`);
											break;
										} catch (pingError) {
											debugLog('NavigateAndExtractMarkdown', `Content script ping failed (attempt ${attempt + 1}), injecting...`);
											try {
												await browser.scripting.executeScript({
													target: { tabId: tabId },
													files: ['content.js']
												});
												// Wait after injection
												await new Promise(resolve => setTimeout(resolve, 1500));
											} catch (injectError) {
												console.warn('Content script injection failed:', injectError);
											}
										}
									}
									
									if (!contentScriptReady) {
										debugLog('NavigateAndExtractMarkdown', 'Content script not ready after attempts, trying to extract anyway...');
									}
									
									// Extract page content (HTML) - try multiple times
									let contentResponse = null;
									for (let attempt = 0; attempt < 3; attempt++) {
										try {
											contentResponse = await extractPageContent(tabId);
											if (contentResponse && contentResponse.content) {
												debugLog('NavigateAndExtractMarkdown', `HTML extracted successfully (attempt ${attempt + 1})`);
												break;
											}
										} catch (extractError) {
											console.warn(`Content extraction attempt ${attempt + 1} failed:`, extractError);
											if (attempt < 2) {
												await new Promise(resolve => setTimeout(resolve, 1000));
											}
										}
									}
									
									if (!contentResponse || !contentResponse.content) {
										reject(new Error('Failed to extract page content after multiple attempts'));
										return;
									}
									
									debugLog('NavigateAndExtractMarkdown', 'Converting HTML to markdown...');
									
									// Initialize page content to get markdown
									const initializedContent = await initializePageContent(
										contentResponse.content,
										contentResponse.selectedHtml,
										contentResponse.extractedContent,
										currentUrl,
										contentResponse.schemaOrgData,
										contentResponse.fullHtml,
										contentResponse.highlights || [],
										contentResponse.title,
										contentResponse.author,
										contentResponse.description,
										contentResponse.favicon,
										contentResponse.image,
										contentResponse.published,
										contentResponse.site,
										contentResponse.wordCount,
										contentResponse.metaTags
									);
									
									if (!initializedContent || !initializedContent.currentVariables) {
										reject(new Error('Failed to initialize page content'));
										return;
									}
									
									// Get the markdown from variables ({{content}} is the markdown)
									const markdown = initializedContent.currentVariables['{{content}}'] || '';
									
									debugLog('NavigateAndExtractMarkdown', `Markdown conversion successful, length: ${markdown.length}`);
									
									resolve(markdown);
								} catch (error) {
									reject(error);
								}
							}, 3000); // Wait 3 seconds for content to be ready
						}
					}
				};
				
				// Add the listener BEFORE navigating
				browser.tabs.onUpdated.addListener(onUpdatedListener);
				
				// Navigate to the URL
				browser.tabs.update(tabId, { url: url }).then(() => {
					debugLog('NavigateAndExtractMarkdown', 'Navigation command sent');
					// Also check immediately in case the page is already loaded
					browser.tabs.get(tabId).then((tab) => {
						if (tab.status === 'complete') {
							const currentUrl = tab.url || '';
							const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
							if (normalizedCurrentUrl === normalizedTargetUrl) {
								debugLog('NavigateAndExtractMarkdown', 'Page already loaded');
								onUpdatedListener(tabId, { status: 'complete' }, tab);
							}
						}
					}).catch(() => {
						// Ignore errors, the listener will handle it
					});
				}).catch((error) => {
					browser.tabs.onUpdated.removeListener(onUpdatedListener);
					if (timeoutId) {
						clearTimeout(timeoutId);
					}
					reject(error);
				});
			});
		}

		const scrapeAllPagesBtn = document.getElementById('scrape-all-pages-btn') as HTMLButtonElement;
		if (scrapeAllPagesBtn) {
			scrapeAllPagesBtn.addEventListener('click', async (e) => {
				e.preventDefault();
				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
				if (noteContentField && noteNameField && currentTabId) {
					const saveJsonBtn = document.getElementById('save-json-btn') as HTMLButtonElement;
					const obtainProductsBtn = document.getElementById('obtain-products-btn') as HTMLButtonElement;
					
					// Reset stop flag
					shouldStopScraper = false;
					
					// Show stop button and reset its text
					const stopScraperBtn = document.getElementById('stop-scraper-btn') as HTMLButtonElement;
					if (stopScraperBtn) {
						stopScraperBtn.style.display = 'block';
						stopScraperBtn.disabled = false;
						stopScraperBtn.textContent = getMessage('stopScraperAndSave');
					}
					
					try {
						scrapeAllPagesBtn.classList.add('processing');
						scrapeAllPagesBtn.disabled = true;
						
						// Also disable other buttons
						if (saveJsonBtn) {
							saveJsonBtn.disabled = true;
						}
						if (obtainProductsBtn) {
							obtainProductsBtn.disabled = true;
						}
						
						// Get current page URL
						const tab = await getTabInfo(currentTabId);
						const baseUrl = tab.url;
						
						// Load saved parser code
						debugLog('ScrapeAllPages', 'Loading saved parser code...');
						const savedCode = await loadSavedParserCode(baseUrl);
						
						if (!savedCode) {
							throw new Error('No saved parser code found for this page. Please use "Generate Code and Save" first to generate the parser code.');
						}
						
						// Extract base URL without pagination
						const urlObj = new URL(baseUrl);
						
						// Remove any existing pagination parameters to get base URL
						urlObj.searchParams.delete('pagina');
						urlObj.searchParams.delete('page');
						const baseUrlWithoutPagination = urlObj.toString();
						
						// Read user preference for pagination parameter
						const usePaginaParamCheckbox = document.getElementById('use-pagina-param') as HTMLInputElement;
						const usePaginaParam = usePaginaParamCheckbox ? usePaginaParamCheckbox.checked : false;
						
						// Read user preference for maximum pages
						const maxPagesInput = document.getElementById('max-pages-input') as HTMLInputElement;
						const maxPages = maxPagesInput ? parseInt(maxPagesInput.value, 10) || 500 : 500;
						
						const allProducts: any[] = [];
						let pageNumber = 1;
						let hasMorePages = true;
						
						// First, scrape the current page
						try {
							// Update button text
							scrapeAllPagesBtn.textContent = `${getMessage('processing')}...${pageNumber}`;
							
							debugLog('ScrapeAllPages', `Processing current page (page ${pageNumber})...`);
							
							// Get current page markdown (use noteContentField if available, otherwise extract and convert)
							let currentPageMarkdown: string;
							if (noteContentField.value && noteContentField.value.trim().length > 0) {
								currentPageMarkdown = noteContentField.value;
								debugLog('ScrapeAllPages', 'Using markdown from noteContentField');
							} else {
								debugLog('ScrapeAllPages', 'Extracting current page content and converting to markdown...');
								// Extract HTML and convert to markdown
								const contentResponse = await extractPageContent(currentTabId);
								if (!contentResponse || !contentResponse.content) {
									throw new Error('Failed to extract current page content');
								}
								
								// Convert HTML to markdown
								const tab = await getTabInfo(currentTabId);
								const initializedContent = await initializePageContent(
									contentResponse.content,
									contentResponse.selectedHtml,
									contentResponse.extractedContent,
									tab.url,
									contentResponse.schemaOrgData,
									contentResponse.fullHtml,
									contentResponse.highlights || [],
									contentResponse.title,
									contentResponse.author,
									contentResponse.description,
									contentResponse.favicon,
									contentResponse.image,
									contentResponse.published,
									contentResponse.site,
									contentResponse.wordCount,
									contentResponse.metaTags
								);
								
								if (!initializedContent || !initializedContent.currentVariables) {
									throw new Error('Failed to convert HTML to markdown');
								}
								
								// Get the markdown from variables ({{content}} is the markdown)
								currentPageMarkdown = initializedContent.currentVariables['{{content}}'] || '';
								debugLog('ScrapeAllPages', 'Markdown conversion successful');
							}
							
							// Execute parser code on the markdown content
							const extractedProducts = await executeParserCode(savedCode, currentPageMarkdown, currentTabId);
							
							// Check if we got products
							if (!extractedProducts || extractedProducts.length === 0) {
								debugLog('ScrapeAllPages', `No products found on current page, stopping.`);
								hasMorePages = false;
							} else {
								// Add products to the accumulated list
								allProducts.push(...extractedProducts);
								debugLog('ScrapeAllPages', `Current page: Found ${extractedProducts.length} products. Total so far: ${allProducts.length}`);
								
								// Move to next page
								pageNumber++;
							}
						} catch (pageError) {
							console.error(`Error processing current page:`, pageError);
							throw pageError;
						}
						
						// Now iterate through remaining pages
						let consecutiveFailures = 0;
						const maxConsecutiveFailures = 2; // Allow 2 consecutive failures before stopping
						
						while (hasMorePages && pageNumber <= maxPages && !shouldStopScraper) { // User-configurable limit
							try {
								// Check if user wants to stop
								if (shouldStopScraper) {
									debugLog('ScrapeAllPages', 'User requested to stop scraper');
									break;
								}
								
								// Update button text
								scrapeAllPagesBtn.textContent = `${getMessage('processing')}...${pageNumber}`;
								
								// Build URL for this page
								const pageUrl = buildPaginationUrl(baseUrlWithoutPagination, pageNumber, usePaginaParam);
								
								debugLog('ScrapeAllPages', `Processing page ${pageNumber}: ${pageUrl}`);
								
								// Navigate to the page, extract HTML, convert to markdown - retry up to 3 times
								let pageMarkdown: string | null = null;
								let navigationSuccess = false;
								
								for (let navAttempt = 0; navAttempt < 3; navAttempt++) {
									try {
										// Complete flow: navigate -> get HTML -> get markdown
										pageMarkdown = await navigateAndExtractMarkdown(currentTabId, pageUrl);
										navigationSuccess = true;
										debugLog('ScrapeAllPages', `Navigation and markdown extraction successful (attempt ${navAttempt + 1})`);
										break;
									} catch (navError) {
										console.warn(`Navigation/markdown extraction attempt ${navAttempt + 1} failed for page ${pageNumber}:`, navError);
										if (navAttempt < 2) {
											await new Promise(resolve => setTimeout(resolve, 2000));
										}
									}
								}
								
								if (!navigationSuccess || !pageMarkdown) {
									throw new Error(`Failed to navigate to page ${pageNumber} and extract markdown after multiple attempts`);
								}
								
								// Execute parser code on the markdown content
								const extractedProducts = await executeParserCode(savedCode, pageMarkdown, currentTabId);
								
								// Check if we got products
								if (!extractedProducts || extractedProducts.length === 0) {
									debugLog('ScrapeAllPages', `No products found on page ${pageNumber}`);
									consecutiveFailures++;
									
									if (consecutiveFailures >= maxConsecutiveFailures) {
										debugLog('ScrapeAllPages', `Stopping after ${consecutiveFailures} consecutive pages with no products`);
										hasMorePages = false;
										break;
									}
									
									// Try next page even if this one had no products
									pageNumber++;
									await new Promise(resolve => setTimeout(resolve, 1000));
									continue;
								}
								
								// Reset failure counter on success
								consecutiveFailures = 0;
								
								// Add products to the accumulated list
								allProducts.push(...extractedProducts);
								debugLog('ScrapeAllPages', `Page ${pageNumber}: Found ${extractedProducts.length} products. Total so far: ${allProducts.length}`);
								
								// Move to next page
								pageNumber++;
								
								// Small delay between pages to avoid overwhelming the server
								await new Promise(resolve => setTimeout(resolve, 1500));
								
								// Check again if user wants to stop after delay
								if (shouldStopScraper) {
									debugLog('ScrapeAllPages', 'User requested to stop scraper after delay');
									break;
								}
								
							} catch (pageError) {
								console.error(`Error processing page ${pageNumber}:`, pageError);
								consecutiveFailures++;
								
								if (consecutiveFailures >= maxConsecutiveFailures) {
									debugLog('ScrapeAllPages', `Stopping after ${consecutiveFailures} consecutive errors`);
									hasMorePages = false;
									break;
								}
								
								// Try next page even if this one failed
								debugLog('ScrapeAllPages', `Retrying next page after error (failure ${consecutiveFailures}/${maxConsecutiveFailures})`);
								pageNumber++;
								await new Promise(resolve => setTimeout(resolve, 2000));
							}
						}
						
						// Save the accumulated results
						const wasStopped = shouldStopScraper;
						const pagesProcessed = wasStopped ? pageNumber - 1 : pageNumber - 1;
						debugLog('ScrapeAllPages', `Saving results: ${allProducts.length} total products from ${pagesProcessed} pages${wasStopped ? ' (stopped by user)' : ''}`);
						const sanitizedTitle = noteNameField.value.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled';
						const jsonFileName = `code-generated/${sanitizedTitle}/extracted-products-all-pages.json`;
						
						await saveFile({
							content: JSON.stringify(allProducts, null, 2),
							fileName: jsonFileName,
							mimeType: 'application/json',
							tabId: currentTabId
						});
						
						debugLog('ScrapeAllPages', 'Process completed successfully');
						if (wasStopped) {
							scrapeAllPagesBtn.textContent = `Stopped: ${allProducts.length} products from ${pagesProcessed} pages saved`;
						} else {
							scrapeAllPagesBtn.textContent = `Completed: ${allProducts.length} products from ${pagesProcessed} pages`;
						}
						
					} catch (error) {
						console.error('Failed to scrape all pages:', error);
						alert(getMessage('scrapeAllPagesError'));
						scrapeAllPagesBtn.textContent = getMessage('scrapeAllPages');
					} finally {
						scrapeAllPagesBtn.classList.remove('processing');
						scrapeAllPagesBtn.disabled = false;
						
						// Hide stop button and show scrape button
						const stopScraperBtn = document.getElementById('stop-scraper-btn') as HTMLButtonElement;
						if (stopScraperBtn) {
							stopScraperBtn.style.display = 'none';
							stopScraperBtn.disabled = false;
						}
						
						// Re-enable other buttons
						if (saveJsonBtn) {
							saveJsonBtn.disabled = false;
						}
						if (obtainProductsBtn) {
							obtainProductsBtn.disabled = false;
						}
						
						// Reset stop flag
						shouldStopScraper = false;
						
						// Reset button text after a delay
						setTimeout(() => {
							scrapeAllPagesBtn.textContent = getMessage('scrapeAllPages');
						}, 3000);
					}
				}
			});
		}

		// Add event listener for stop scraper button
		const stopScraperBtn = document.getElementById('stop-scraper-btn') as HTMLButtonElement;
		if (stopScraperBtn) {
			stopScraperBtn.addEventListener('click', async (e) => {
				e.preventDefault();
				shouldStopScraper = true;
				debugLog('ScrapeAllPages', 'Stop scraper button clicked');
				
				// Disable the stop button to prevent multiple clicks
				stopScraperBtn.disabled = true;
				stopScraperBtn.textContent = getMessage('stopping') || 'Stopping...';
			});
		}
		// Initialize the rest of the popup
		if (currentTabId) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				return;
			}

			try {
				// DOM-dependent initializations
				updateVaultDropdown(loadedSettings.vaults);
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await initializeUI();

				// Initial content load
				await refreshFields(currentTabId);

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}
				// determineMainAction(); // Removed - action buttons no longer used
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError(getMessage('pleaseReload'));
			}
		} else {
			showError(getMessage('pleaseReload'));
		}
	} catch (error) {
		console.error('Error getting active tab:', error);
		showError(getMessage('pleaseReload'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		highlighterModeButton.addEventListener('click', () => toggleHighlighterMode(tabId));
	}

	const embeddedModeButton = document.getElementById('embedded-mode');
		if (embeddedModeButton) {
			embeddedModeButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error toggling emedded iframe:', error);
				}
			});
		}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const copyContentButton = document.getElementById('copy-content');
	const saveDownloadsButton = document.getElementById('save-downloads');
	const shareContentButton = document.getElementById('share-content');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			moreDropdown.classList.toggle('show');
		});

		// Close dropdown when clicking outside
		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
			}
		});
	}

	if (copyContentButton) {
		copyContentButton.addEventListener('click', async () => {
			const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
				const inputElement = input as HTMLInputElement;
				return {
					id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
					name: inputElement.id,
					value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
				};
			}) as Property[];

			const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
			const frontmatter = await generateFrontmatter(properties);
			const fileContent = frontmatter + noteContentField.value;
			
			await copyToClipboard(fileContent);
		});
	}

	if (saveDownloadsButton) {
		saveDownloadsButton.addEventListener('click', handleSaveToDownloads);
	}

	const shareButtons = document.querySelectorAll('.share-content');
	if (shareButtons) {
		shareButtons.forEach(button => {
			button.addEventListener('click', async (e) => {
				// Get content synchronously
				const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
					const inputElement = input as HTMLInputElement;
					return {
						id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
						name: inputElement.id,
						value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
					};
				}) as Property[];

				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				
				// Use Promise.all to prepare the data
				Promise.all([
					generateFrontmatter(properties),
					Promise.resolve(noteContentField.value)
				]).then(([frontmatter, noteContent]) => {
					const fileContent = frontmatter + noteContent;
					
					// Call share directly from the click handler
					const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
					let fileName = noteNameField?.value || 'untitled';
					fileName = sanitizeFileName(fileName);
					if (!fileName.toLowerCase().endsWith('.md')) {
						fileName += '.md';
					}

					if (navigator.share && navigator.canShare) {
						const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
						const file = new File([blob], fileName, { type: 'text/markdown;charset=utf-8' });
						
						const shareData = {
							files: [file],
							text: 'Shared from Web Clipper'
						};

						if (navigator.canShare(shareData)) {
							const pathField = document.getElementById('path-name-field') as HTMLInputElement;
							const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
							const path = pathField?.value || '';
							const vault = vaultDropdown?.value || '';

							navigator.share(shareData)
								.then(async () => {
									const tabInfo = await getCurrentTabInfo();
									await incrementStat('share', vault, path, tabInfo.url, tabInfo.title);
									const moreDropdown = document.getElementById('more-dropdown');
									if (moreDropdown) {
											moreDropdown.classList.remove('show');
									}
								})
								.catch((error) => {
									console.error('Error sharing:', error);
								});
						}
					}
				});
			});
		});
	}

	const shareButtonElements = document.querySelectorAll('.share-content');
	if (shareButtonElements.length > 0) {
		detectBrowser().then(browser => {
			const isSafariBrowser = ['safari', 'mobile-safari', 'ipad-os'].includes(browser);
			if (!isSafariBrowser || !navigator.share || !navigator.canShare) {
				shareButtonElements.forEach(button => {
					const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
					if (parentElement) {
						parentElement.style.display = 'none';
					}
				});
			} else {
				// Test if we can share files (only on Safari)
				const testFile = new File(["test"], "test.txt", { type: "text/plain" });
				const testShare = { files: [testFile] };
				if (!navigator.canShare(testShare)) {
					shareButtonElements.forEach(button => {
						const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
						if (parentElement) {
							parentElement.style.display = 'none';
						}
					});
				}
			}
		});
	}

	const readerModeButton = document.getElementById('reader-mode');
	if (readerModeButton) {
		readerModeButton.addEventListener('click', () => toggleReaderMode(tabId));
	}
}

async function initializeUI() {
	// Clip button removed - no longer needed
	// Focus is now on save-json-btn or other visible buttons
	const saveJsonBtn = document.getElementById('save-json-btn');
	if (saveJsonBtn) {
		saveJsonBtn.focus();
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			// Initialize the variables panel with the latest data
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		browser.runtime.sendMessage({ action: "sidePanelOpened" });
		
		window.addEventListener('unload', () => {
			browser.runtime.sendMessage({ action: "sidePanelClosed" });
		});
	}
}

function showError(messageKey: string): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = getMessage(messageKey);
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';

		document.body.classList.add('has-error');
	}
}
function clearError(): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.style.display = 'none';
		clipper.style.display = 'block';

		document.body.classList.remove('has-error');
	}
}

function logError(message: string, error?: any): void {
	console.error(message, error);
	showError(message);
}

async function refreshFields(tabId: number, checkTemplateTriggers: boolean = true) {
	if (templates.length === 0) {
		console.warn('No templates available');
		showError('noTemplates');
		return;
	}

	try {
		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}

		const extractedData = await memoizedExtractPageContent(tabId);
		if (extractedData) {
			const currentUrl = tab.url;

			// Only check for the correct template if checkTemplateTriggers is true
			if (checkTemplateTriggers) {
				const getSchemaOrgData = async () => {
					return extractedData.schemaOrgData;
				};

				const matchedTemplate = await findMatchingTemplate(currentUrl, getSchemaOrgData);
				if (matchedTemplate) {
					console.log('Matched template:', matchedTemplate);
					currentTemplate = matchedTemplate;
					updateTemplateDropdown();
				}
			}

			const initializedContent = await initializePageContent(
				extractedData.content,
				extractedData.selectedHtml,
				extractedData.extractedContent,
				currentUrl,
				extractedData.schemaOrgData,
				extractedData.fullHtml,
				extractedData.highlights || [],
				extractedData.title,
				extractedData.author,
				extractedData.description,
				extractedData.favicon,
				extractedData.image,
				extractedData.published,
				extractedData.site,
				extractedData.wordCount,
				extractedData.metaTags
			);
			if (initializedContent) {
				currentVariables = initializedContent.currentVariables;
				console.log('Updated currentVariables:', currentVariables);
				await initializeTemplateFields(
					tabId,
					currentTemplate,
					initializedContent.currentVariables,
					initializedContent.noteName,
					extractedData.schemaOrgData
				);
				setupMetadataToggle();

				// Update variables panel if it's open
				updateVariablesPanel(currentTemplate, currentVariables);
			} else {
				throw new Error('Unable to initialize page content.');
			}
		} else {
			throw new Error('Unable to extract page content.');
		}
	} catch (error) {
		console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		// Clear existing options
		templateDropdown.textContent = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

async function initializeTemplateFields(currentTabId: number, template: Template | null, variables: { [key: string]: string }, noteName?: string, schemaOrgData?: any) {
	if (!template) {
		logError('No template selected');
		return;
	}

	// Handle vault selection
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	if (vaultDropdown) {
		if (template.vault) {
			vaultDropdown.value = template.vault;
		} else if (lastSelectedVault) {
			vaultDropdown.value = lastSelectedVault;
		}
	}

	currentVariables = variables;
	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	// Create a new off-screen element
	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');
	newTemplateProperties.style.position = 'absolute';
	newTemplateProperties.style.left = '-9999px';
	document.body.appendChild(newTemplateProperties);

	if (!Array.isArray(template.properties)) {
		logError('Template properties are not an array');
		return;
	}

	for (const property of template.properties) {
		const propertyDiv = createElementWithClass('div', 'metadata-property');
		let value = await memoizedCompileTemplate(currentTabId!, unescapeValue(property.value), variables, currentTabId ? await getTabInfo(currentTabId).then(tab => tab.url || '') : '');

		const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

		// Apply type-specific parsing
		switch (propertyType) {
			case 'number':
				const numericValue = value.replace(/[^\d.-]/g, '');
				value = numericValue ? parseFloat(numericValue).toString() : value;
				break;
			case 'checkbox':
				value = (value.toLowerCase() === 'true' || value === '1').toString();
				break;
			case 'date':
				// Don't override user-specified date format
				if (!property.value.includes('|date:')) {
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : value;
				}
				break;
			case 'datetime':
				// Don't override user-specified datetime format
				if (!property.value.includes('|date:')) {
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DDTHH:mm:ssZ') : value;
				}
				break;
		}

		// Create metadata property key container
		const metadataPropertyKey = document.createElement('div');
		metadataPropertyKey.className = 'metadata-property-key';
		
		// Create property icon
		const propertyIconSpan = document.createElement('span');
		propertyIconSpan.className = 'metadata-property-icon';
		const iconElement = document.createElement('i');
		iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
		propertyIconSpan.appendChild(iconElement);
		
		// Create property label
		const propertyLabel = document.createElement('label');
		propertyLabel.setAttribute('for', property.name);
		propertyLabel.textContent = property.name;
		
		// Assemble key container
		metadataPropertyKey.appendChild(propertyIconSpan);
		metadataPropertyKey.appendChild(propertyLabel);
		
		// Create metadata property value container
		const metadataPropertyValue = document.createElement('div');
		metadataPropertyValue.className = 'metadata-property-value';
		
		// Create input element based on type
		const inputElement = document.createElement('input');
		inputElement.id = property.name;
		inputElement.setAttribute('data-type', propertyType);
		inputElement.setAttribute('data-template-value', property.value);
		
		if (propertyType === 'checkbox') {
			inputElement.type = 'checkbox';
			if (value === 'true') {
				inputElement.checked = true;
			}
		} else {
			inputElement.type = 'text';
			inputElement.value = value;
		}
		
		metadataPropertyValue.appendChild(inputElement);
		
		// Assemble property div
		propertyDiv.appendChild(metadataPropertyKey);
		propertyDiv.appendChild(metadataPropertyValue);
		newTemplateProperties.appendChild(propertyDiv);
	}

	// Replace the existing element with the new one
	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		// Remove the old element from the DOM
		existingTemplateProperties.remove();
	}

	// Remove the temporary styling
	newTemplateProperties.style.position = '';
	newTemplateProperties.style.left = '';

	initializeIcons(newTemplateProperties);

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		let formattedNoteName = await memoizedCompileTemplate(currentTabId!, template.noteNameFormat, variables, currentTabId ? await getTabInfo(currentTabId).then(tab => tab.url || '') : '');
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const pathContainer = document.querySelector('.vault-path-container') as HTMLElement;
	
	if (pathField && pathContainer) {
		const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';
		
		if (isDailyNote) {
			pathField.style.display = 'none';
		} else {
			pathContainer.style.display = 'flex';
			let formattedPath = await memoizedCompileTemplate(currentTabId!, template.path, variables, currentTabId ? await getTabInfo(currentTabId).then(tab => tab.url || '') : '');
			pathField.value = formattedPath;
			pathField.setAttribute('data-template-value', template.path);
		}
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		if (template.noteContentFormat) {
			let content = await memoizedCompileTemplate(currentTabId!, template.noteContentFormat, variables, currentTabId ? await getTabInfo(currentTabId).then(tab => tab.url || '') : '');
			noteContentField.value = content;
			noteContentField.setAttribute('data-template-value', template.noteContentFormat);
		} else {
			noteContentField.value = '';
			noteContentField.setAttribute('data-template-value', '');
		}
	}

	if (template) {
		const replacedTemplate = await getReplacedTemplate(template, variables, currentTabId!, currentTabId ? await getTabInfo(currentTabId).then(tab => tab.url || '') : '');
		debugLog('Variables', 'Current template with replaced variables:', JSON.stringify(replacedTemplate, null, 2));
	}
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	
	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			if (isCollapsed === undefined) {
				// If the value is not set, default to not collapsed
				updateMetadataToggleState(false); 
			} else {
				updateMetadataToggleState(isCollapsed);
			}
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

async function getReplacedTemplate(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string): Promise<any> {
	const replacedTemplate: any = {
		schemaVersion: "0.1.0",
		name: template.name,
		behavior: template.behavior,
		noteNameFormat: await compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		path: template.path,
		noteContentFormat: await compileTemplate(tabId, template.noteContentFormat, variables, currentUrl),
		properties: [],
		triggers: template.triggers
	};

	if (template.context) {
		replacedTemplate.context = await compileTemplate(tabId, template.context, variables, currentUrl);
	}

	for (const prop of template.properties) {
		const replacedProp: Property = {
			id: prop.id,
			name: prop.name,
			value: await compileTemplate(tabId, prop.value, variables, currentUrl)
		};
		replacedTemplate.properties.push(replacedProp);
	}

	return replacedTemplate;
}

function updateVaultDropdown(vaults: string[]) {
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement | null;
	const vaultContainer = document.getElementById('vault-container');

	if (!vaultDropdown || !vaultContainer) return;

	// Clear existing options
	vaultDropdown.textContent = '';
	
	vaults.forEach(vault => {
		const option = document.createElement('option');
		option.value = vault;
		option.textContent = vault;
		vaultDropdown.appendChild(option);
	});

	// Only show vault selector if vaults are defined
	if (vaults.length > 0) {
		vaultContainer.style.display = 'block';
		if (lastSelectedVault && vaults.includes(lastSelectedVault)) {
			vaultDropdown.value = lastSelectedVault;
		} else {
			vaultDropdown.value = vaults[0];
		}
	} else {
		vaultContainer.style.display = 'none';
	}

	// Add event listener to update lastSelectedVault when changed
	vaultDropdown.addEventListener('change', () => {
		lastSelectedVault = vaultDropdown.value;
		setLocalStorage('lastSelectedVault', lastSelectedVault);
	});
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find(t => t.id === templateId) || templates[0];
	refreshFields(currentTabId!, false);
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "getHighlighterMode",
			tabId: tabId
		}) as { isActive: boolean };

		const isHighlighterMode = response.isActive;
		
		loadedSettings = await loadSettings();
		
		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "toggleHighlighterMode",
			tabId: tabId
		}) as { success: boolean, isActive: boolean, error?: string };

		if (response && response.success) {
			const isNowActive = response.isActive;
			updateHighlighterModeUI(isNowActive);

			// Close the popup if highlighter mode is turned on and not in side panel
			if (isNowActive && !isSidePanel && !isIframe) {
				setTimeout(() => window.close(), 50);
			}
		} else {
			throw new Error(response.error || "Failed to toggle highlighter mode.");
		}
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		showError('failedToToggleHighlighter');
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('enableHighlighter');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

async function toggleReaderMode(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({ 
			action: "toggleReaderMode",
			tabId: tabId
		}) as ReaderModeResponse;

		if (response && response.success) {
			const readerButton = document.getElementById('reader-mode');
			if (readerButton) {
				const isActive = response.isActive ?? false;
				readerButton.classList.toggle('active', isActive);
				readerButton.setAttribute('aria-pressed', isActive.toString());
				readerButton.title = isActive ? getMessage('disableReader') : getMessage('enableReader');
			}
		}

		// Close the popup if not in side panel
		if (!isSidePanel) {
			window.close();
		}
	} catch (error) {
		console.error('Error toggling reader mode:', error);
		showError('failedToToggleReaderMode');
	}
}

export async function copyToClipboard(content: string) {
	try {
		await browser.runtime.sendMessage({
			action: 'copy-to-clipboard',
			text: content
		});
		
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		const path = pathField?.value || '';
		const vault = vaultDropdown?.value || '';
		
		const tabInfo = await getCurrentTabInfo();
		await incrementStat('copyToClipboard', vault, path, tabInfo.url, tabInfo.title);

		// Clip button removed - no longer showing copied status
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		showError('failedToCopyText');
	}
}

async function handleSaveToDownloads() {
	try {
		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		
		let fileName = noteNameField?.value || 'untitled';
		const path = pathField?.value || '';
		const vault = vaultDropdown?.value || '';
		
		const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
			const inputElement = input as HTMLInputElement;
			return {
				id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
				name: inputElement.id,
				value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
			};
		}) as Property[];

		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		const frontmatter = await generateFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;

		await saveFile({
			content: fileContent,
			fileName,
			mimeType: 'text/markdown',
			tabId: currentTabId,
			onError: (error) => showError('failedToSaveFile')
		});

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('saveFile', vault, path, tabInfo.url, tabInfo.title);

		const moreDropdown = document.getElementById('more-dropdown');
		if (moreDropdown) {
			moreDropdown.classList.remove('show');
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		showError('failedToSaveFile');
	}
}

// Removed determineMainAction() - action buttons (clip-btn, saveNote, etc.) are no longer used
// function determineMainAction() {
// 	const mainButton = document.getElementById('clip-btn');
// 	const moreDropdown = document.getElementById('more-dropdown');
// 	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
// 	if (!mainButton || !secondaryActions) return;

// 	// Clear existing secondary actions
// 	secondaryActions.textContent = '';

// 	// Set up actions based on saved behavior
// 	switch (loadedSettings.saveBehavior) {
// 		case 'copyToClipboard':
// 			mainButton.textContent = getMessage('copyToClipboard');
// 			mainButton.onclick = () => copyContent();
// 			// Add direct actions to secondary
// 			addSecondaryAction(secondaryActions, 'saveNote', () => handleSaveNote());
// 			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
// 			break;
// 		case 'saveFile':
// 			mainButton.textContent = getMessage('saveFile');
// 			mainButton.onclick = () => handleSaveToDownloads();
// 			// Add direct actions to secondary
// 			addSecondaryAction(secondaryActions, 'saveNote', () => handleSaveNote());
// 			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
// 			break;
// 		default: // 'saveNote'
// 			mainButton.textContent = getMessage('saveNote');
// 			mainButton.onclick = () => handleSaveNote();
// 			// Add direct actions to secondary
// 			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
// 			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
// 	}
// }

async function handleSaveNote(): Promise<void> {
	if (!currentTemplate) return;

	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
	const pathField = document.getElementById('path-name-field') as HTMLInputElement;

	if (!vaultDropdown || !noteContentField) {
		showError('Some required fields are missing. Please try reloading the extension.');
		return;
	}

	try {
		// Gather content
		const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
			const inputElement = input as HTMLInputElement;
			return {
				id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
				name: inputElement.id,
				value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
			};
		}) as Property[];

		const frontmatter = await generateFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;

		// Save Note
		const selectedVault = currentTemplate.vault || vaultDropdown.value;
		const isDailyNote = currentTemplate.behavior === 'append-daily' || currentTemplate.behavior === 'prepend-daily';
		const noteName = isDailyNote ? '' : noteNameField?.value || '';
		const path = isDailyNote ? '' : pathField?.value || '';

		await saveNote(fileContent, noteName, path, currentTemplate.behavior, currentTabId);
		const tabInfo = await getCurrentTabInfo();
		await incrementStat('saveNote', selectedVault, path, tabInfo.url, tabInfo.title);

		if (!currentTemplate.vault) {
			lastSelectedVault = selectedVault;
			await setLocalStorage('lastSelectedVault', lastSelectedVault);
		}

		if (!isSidePanel) {
			setTimeout(() => window.close(), 500);
		}
	} catch (error) {
		console.error('Error in handleSaveNote:', error);
		showError('failedToSaveFile');
		throw error;
	}
}

function addSecondaryAction(container: Element, actionType: string, handler: () => void) {
	const menuItem = document.createElement('div');
	menuItem.className = 'menu-item';
	
	// Create menu item icon container
	const menuItemIcon = document.createElement('div');
	menuItemIcon.className = 'menu-item-icon';
	
	const iconElement = document.createElement('i');
	iconElement.setAttribute('data-lucide', getActionIcon(actionType));
	menuItemIcon.appendChild(iconElement);
	
	// Create menu item title
	const menuItemTitle = document.createElement('div');
	menuItemTitle.className = 'menu-item-title';
	menuItemTitle.setAttribute('data-i18n', actionType);
	menuItemTitle.textContent = getMessage(actionType);
	
	// Assemble menu item
	menuItem.appendChild(menuItemIcon);
	menuItem.appendChild(menuItemTitle);
	
	menuItem.addEventListener('click', handler);
	container.appendChild(menuItem);
	initializeIcons(menuItem);
}

function getActionIcon(actionType: string): string {
	switch (actionType) {
		case 'copyToClipboard': return 'copy';
		case 'saveFile': return 'file-down';
		case 'saveNote': return 'pen-line';
		default: return 'plus';
	}
}

async function copyContent() {
	const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
		};
	}) as Property[];

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const frontmatter = await generateFrontmatter(properties);
	const fileContent = frontmatter + noteContentField.value;
	await copyToClipboard(fileContent);
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);

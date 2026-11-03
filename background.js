// CoachMate Slow Down - service worker.
// On tabs where the content script is running (lichess.org, chess.com) the toolbar icon shows or
// hides the on-page panel; everywhere else it opens the settings popup from the manifest. The
// worker never reads tab URLs (that would need an extra permission): the content script reports
// in when it starts, and any navigation in a tab puts the settings popup back until it does.
const SETTINGS_POPUP = 'popup/popup.html';

async function setMode(tabId, game) {
  try {
    await chrome.action.setPopup({ tabId, popup: game ? '' : SETTINGS_POPUP });
    await chrome.action.setTitle({ tabId, title: game ? 'CoachMate Slow Down · show / hide the panel' : 'CoachMate Slow Down' });
  } catch (_) { /* tab went away */ }
}

chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') setMode(tabId, false); });

// Only fires on tabs with no popup, i.e. game tabs. If the content script is gone (extension was
// reloaded under an open tab), fall back to the settings page.
chrome.action.onClicked.addListener(tab => {
  if (tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }).catch(() => chrome.runtime.openOptionsPage());
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'panelReady' && sender.tab && sender.tab.id != null) setMode(sender.tab.id, true);
  else if (msg.type === 'openOptions') chrome.runtime.openOptionsPage();
});

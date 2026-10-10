/**
 * fileSave.js
 * Saving a text file the page made (an exported collection). Each place the app runs does it its own way:
 *   Android   the app's bridge saves into the Downloads folder
 *   iPhone    the app's bridge offers the share sheet (Files, AirDrop, Mail…)
 *   desktop   the local backend writes it into the Downloads folder
 *   website   an ordinary browser download
 * Resolves to { ok: true, where } ("where" is a place to tell the user about) or { ok: false, error }; never throws.
 */
import { IS_WEB } from './env.js';

function downloadInBrowser(name, text, mime) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ok: true, where: 'your downloads' };
  } catch (e) {
    return { ok: false, error: "Couldn't save the file" };
  }
}

export async function saveTextFile(name, text, mime = 'text/csv') {
  try {
    if (window.BinderAndroid && typeof window.BinderAndroid.saveFile === 'function') {
      const result = JSON.parse(window.BinderAndroid.saveFile(name, text));
      return result.ok ? { ok: true, where: result.where } : { ok: false, error: result.error || "Couldn't save the file" };
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.binderSave) {
      window.webkit.messageHandlers.binderSave.postMessage({ name, text });
      return { ok: true, where: 'the share sheet' };
    }
    if (!IS_WEB) {
      const res = await fetch('/api/save-file', { method: 'POST', body: JSON.stringify({ name, content: text }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, where: data.path || 'your Downloads folder' };
      if (res.status !== 501 && res.status !== 404) return { ok: false, error: data.error || "Couldn't save the file" };
    }
  } catch (e) {
    // fall through to the browser's own way
  }
  return downloadInBrowser(name, text, mime);
}

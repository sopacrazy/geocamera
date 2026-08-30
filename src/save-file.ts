import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Saves a file to the device. On the web (desktop browser) this triggers a
 * normal download. Inside the packaged Android app a plain `<a download>`
 * click is unreliable in the WebView and rarely produces a visible file, so
 * there we write to the app cache and hand it to Android's native share
 * sheet, letting the user pick "Save to Files/Photos" themselves.
 */
export async function saveFile(source: string | Blob, filename: string): Promise<void> {
  if (Capacitor.getPlatform() === 'web') {
    const href = typeof source === 'string' ? source : URL.createObjectURL(source);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.click();
    if (typeof source !== 'string') setTimeout(() => URL.revokeObjectURL(href), 4000);
    return;
  }

  const base64 = typeof source === 'string'
    ? (source.split(',')[1] ?? source)
    : await blobToBase64(source);

  const result = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  await Share.share({
    url: result.uri,
    dialogTitle: 'Salvar arquivo',
  });
}

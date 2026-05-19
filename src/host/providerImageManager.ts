import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Build image path mapping from original paths to webview URIs.
 * Returns a map like { "./image.jpg": "vscode-webview://..." }
 */
export function buildImagePathMap(
  markdown: string,
  webview: vscode.Webview,
  documentUri: vscode.Uri
): Record<string, string> {
  const documentDir = vscode.Uri.joinPath(documentUri, '..');
  const pathMap: Record<string, string> = {};
  const imageDirs: vscode.Uri[] = [];

  const processImagePath = (src: string) => {
    const originalSrc = src; // Keep original (possibly encoded) version

    // Decode URL-encoded characters (e.g., %5C -> \)
    let decodedSrc = src;
    try {
      decodedSrc = decodeURIComponent(src);
    } catch (e) {
      // If decoding fails, use original
    }

    // Skip http/https/data URLs
    if (decodedSrc.startsWith('http://') || decodedSrc.startsWith('https://') || decodedSrc.startsWith('data:')) {
      return;
    }

    // Skip if already processed
    if (pathMap[decodedSrc]) {
      return;
    }

    try {
      // Convert to absolute path (using decoded path)
      let imagePath: vscode.Uri;
      if (path.isAbsolute(decodedSrc)) {
        imagePath = vscode.Uri.file(decodedSrc);
      } else {
        // Relative path - resolve from document directory
        imagePath = vscode.Uri.joinPath(documentDir, decodedSrc);
      }

      // Track image directory for localResourceRoots expansion
      const imageDir = vscode.Uri.joinPath(imagePath, '..');
      imageDirs.push(imageDir);

      // Convert to webview URI
      const webviewUri = webview.asWebviewUri(imagePath);
      const webviewUriString = webviewUri.toString();

      // Save both encoded and decoded versions as keys
      pathMap[decodedSrc] = webviewUriString;
      if (originalSrc !== decodedSrc) {
        pathMap[originalSrc] = webviewUriString;
      }
    } catch (e) {
      // If conversion fails, skip
      console.error(`Failed to convert image path: ${src}`, e);
    }
  };

  // Match ![...](path) or ![...](<path with spaces>) to find all markdown image paths
  const markdownImageRegex = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]+")?\)/g;
  let match;

  while ((match = markdownImageRegex.exec(markdown)) !== null) {
    processImagePath(match[1] || match[2]);
  }

  // Also match <img src="path"> HTML tags
  const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlImageRegex.exec(markdown)) !== null) {
    processImagePath(match[1]);
  }

  // Expand localResourceRoots with image directories outside current roots
  if (imageDirs.length > 0) {
    const currentRoots = webview.options.localResourceRoots || [];
    const newRoots = [...currentRoots];
    for (const dir of imageDirs) {
      const alreadyIncluded = newRoots.some(r => dir.fsPath.startsWith(r.fsPath));
      if (!alreadyIncluded) {
        newRoots.push(dir);
      }
    }
    if (newRoots.length > currentRoots.length) {
      webview.options = { ...webview.options, localResourceRoots: newRoots };
    }
  }

  return pathMap;
}

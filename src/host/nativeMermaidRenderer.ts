import * as vscode from 'vscode';

export type NativeMermaidRenderOptions = {
  theme: 'default' | 'dark';
  fontFamily?: string;
  numLines?: number;
};

export class NativeMermaidRenderer implements vscode.Disposable {
  public static register(context: vscode.ExtensionContext): NativeMermaidRenderer {
    const renderer = new NativeMermaidRenderer();
    context.subscriptions.push(renderer);
    return renderer;
  }

  dispose(): void {}

  async renderSvg(_source: string, options: NativeMermaidRenderOptions): Promise<string> {
    throw new Error('Native Mermaid preview is disabled because VS Code requires a visible contributed view for the webview renderer.');
  }

  createErrorSvg(message: string, numLines = 5): string {
    const height = Math.max(120, (numLines + 2) * 24);
    const width = 720;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#3b1d1d" stroke="#f85149"/>
<text x="18" y="32" fill="#ffb4ae" font-family="Menlo, Monaco, monospace" font-size="15" font-weight="700">Mermaid Rendering Disabled</text>
<text x="18" y="62" fill="#ffd8d3" font-family="Menlo, Monaco, monospace" font-size="13">${this.escapeXml(message).slice(0, 260)}</text>
</svg>`;
  }

  svgToDataUri(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
